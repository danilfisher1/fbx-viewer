import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import {
  buildTextureSets,
  createGlassMaterial,
  createTileMaterial,
  isGlassMaterialName,
  materialSetKey,
  udimTile,
  createPbrMaterial,
  loadTextureFromBlob,
  DEFAULT_GLASS,
} from "./textureUtils";
import { parseEmbeddedMaterials, EmbeddedMaterial } from "./fbxEmbedded";
import { GeoJsonData, GlassParams } from "./types";
import { log } from "./logger";

const fbxLoader = new FBXLoader();
const fileLoader = new THREE.FileLoader().setResponseType("arraybuffer");

/** FBX + его вшитые материалы/текстуры (для НПМ). Файл читается один раз. */
export function loadFBXWithEmbedded(
  url: string,
  onProgress?: (ratio: number) => void
): Promise<{ group: THREE.Group; embedded: EmbeddedMaterial[] }> {
  return new Promise((resolve, reject) => {
    fileLoader.load(
      url,
      (data) => {
        try {
          const buffer = data as ArrayBuffer;
          const embedded = parseEmbeddedMaterials(buffer);
          resolve({ group: fbxLoader.parse(buffer, ""), embedded });
        } catch (e) {
          reject(e);
        }
      },
      (e) => {
        if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total);
      },
      reject
    );
  });
}

export function loadFBX(
  url: string,
  onProgress?: (ratio: number) => void
): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    fbxLoader.load(
      url,
      resolve,
      (e) => {
        if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total);
      },
      reject
    );
  });
}

/**
 * Материалы ВПМ: по имени материала находим UDIM-набор, режем меш по UV-тайлам
 * (группы геометрии) и на каждый тайл ставим свой материал. Стекло — из geojson.
 * Материалы без своего набора текстур не трогаем.
 */
export async function applyExternalTextures(
  group: THREE.Group,
  textureFiles: { name: string; url: string }[],
  glassMap: Record<string, GlassParams> = {}
): Promise<void> {
  const sets = buildTextureSets(textureFiles);
  const glassKeys = Object.keys(glassMap);
  const findGlass = (name: string): GlassParams | undefined => {
    if (glassMap[name]) return glassMap[name];
    const lower = name.toLowerCase();
    const k = glassKeys.find((g) => g.toLowerCase() === lower);
    if (k) return glassMap[k];
    if (isGlassMaterialName(name) && glassKeys.length) {
      const base = materialSetKey(name);
      const same = glassKeys.find((g) => materialSetKey(g) === base);
      return glassMap[same ?? glassKeys[0]];
    }
    return undefined;
  };

  const shared = new Map<string, Promise<THREE.Material>>();
  const getShared = (key: string, make: () => Promise<THREE.Material>) => {
    let p = shared.get(key);
    if (!p) {
      p = make();
      shared.set(key, p);
    }
    return p;
  };

  const matNames = new Set<string>();
  const missing = new Set<string>();
  const jobs: Promise<void>[] = [];

  group.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || child.name.toLowerCase().startsWith("ucx_")) return;
    const geom = mesh.geometry as THREE.BufferGeometry;
    const srcMats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const uv = geom.getAttribute("uv") as THREE.BufferAttribute | undefined;
    const index = geom.getIndex();
    const vertCount = index ? index.count : geom.getAttribute("position").count;
    const srcGroups = geom.groups.length ? geom.groups : [{ start: 0, count: vertCount, materialIndex: 0 }];

    // ключ слота → [индекс нового материала, фабрика]
    const slots = new Map<string, number>();
    const slotMakers: (() => Promise<THREE.Material>)[] = [];
    const buckets: number[][] = [];
    const slotFor = (mi: number, tile: number): number => {
      const src = srcMats[mi] ?? srcMats[0];
      const name = src?.name ?? "";
      if (name) matNames.add(name);
      let key: string;
      let make: () => Promise<THREE.Material>;
      const glass = name ? findGlass(name) : undefined;
      const set = name && !glass ? sets.get(materialSetKey(name) ?? "") : undefined;
      if (glass) {
        key = `glass:${name}`;
        make = () => getShared(key, async () => createGlassMaterial(glass, name));
      } else if (set) {
        const t = set.maps.diffuse.has(tile) || set.maps.diffuse.size === 0 ? tile : Math.min(...set.maps.diffuse.keys());
        key = `set:${set.key}:${t}`;
        make = () => getShared(key, () => createTileMaterial(set, t));
      } else {
        if (name && !isGlassMaterialName(name)) missing.add(name);
        key = `keep:${mi}`;
        make = async () => src;
      }
      let slot = slots.get(key);
      if (slot === undefined) {
        slot = slotMakers.length;
        slots.set(key, slot);
        slotMakers.push(make);
        buckets.push([]);
      }
      return slot;
    };

    for (const g of srcGroups) {
      const end = Math.min(g.start + g.count, vertCount);
      for (let i = g.start; i + 2 < end; i += 3) {
        const a = index ? index.getX(i) : i;
        const b = index ? index.getX(i + 1) : i + 1;
        const c = index ? index.getX(i + 2) : i + 2;
        const tile = uv
          ? udimTile((uv.getX(a) + uv.getX(b) + uv.getX(c)) / 3, (uv.getY(a) + uv.getY(b) + uv.getY(c)) / 3)
          : 1001;
        buckets[slotFor(g.materialIndex ?? 0, tile)].push(a, b, c);
      }
    }
    if (!slotMakers.length) return;

    const total = buckets.reduce((n, b) => n + b.length, 0);
    const arr = new Uint32Array(total);
    geom.clearGroups();
    let offset = 0;
    buckets.forEach((b, slot) => {
      arr.set(b, offset);
      geom.addGroup(offset, b.length, slot);
      offset += b.length;
    });
    geom.setIndex(new THREE.BufferAttribute(arr, 1));

    jobs.push(
      Promise.all(slotMakers.map((m) => m())).then((mats) => {
        mesh.material = mats.length === 1 ? mats[0] : mats;
      })
    );
  });

  log.info(`Материалов в модели: ${matNames.size}, UDIM-наборов текстур: ${sets.size}, материалов-тайлов: ${shared.size}`);
  if (missing.size) log.warn(`Нет текстур для материалов: ${Array.from(missing).join(", ")}`);
  await Promise.all(jobs);
}

/** Атласы НПМ — по одному на здание, их можно держать крупнее тайлов ВПМ. */
const NPM_TEXTURE_SIZE = 2048;

/** Роль карты НПМ по суффиксу имени (`_d_`, `_r_`, `_m_`, `_o_`, `_n_`), иначе — по слоту FBX. */
function embeddedRole(t: { fileName: string; slot: string }): "map" | "roughnessMap" | "metalnessMap" | "alphaMap" | "normalMap" | null {
  const m = t.fileName.match(/_([dmron])_d+.[a-z]+$/i);
  const byName = { d: "map", r: "roughnessMap", m: "metalnessMap", o: "alphaMap", n: "normalMap" } as const;
  if (m) return byName[m[1].toLowerCase() as keyof typeof byName];
  const slot = t.slot.toLowerCase();
  if (slot.includes("diffuse")) return "map";
  if (slot.includes("shininess")) return "roughnessMap";
  if (slot.includes("reflection")) return "metalnessMap";
  if (slot.includes("transparen")) return "alphaMap";
  if (slot.includes("normal") || slot.includes("bump")) return "normalMap";
  return null;
}

/**
 * НПМ: собираем PBR-материалы из вшитых в FBX карт — FBXLoader подключает только Diffuse,
 * а roughness (ShininessExponent), metallic (ReflectionFactor) и opacity (TransparencyFactor) теряет.
 */
export async function applyEmbeddedPbr(group: THREE.Group, embedded: EmbeddedMaterial[]): Promise<void> {
  const byName = new Map(embedded.map((m) => [m.name, m]));
  const built = new Map<string, Promise<THREE.Material>>();
  const build = (src: THREE.Material): Promise<THREE.Material> => {
    const name = src.name;
    let p = built.get(name);
    if (p) return p;
    const em = byName.get(name);
    if (isGlassMaterialName(name) && !em?.textures.length) {
      p = Promise.resolve(createGlassMaterial(DEFAULT_GLASS, name));
    } else if (em?.textures.length) {
      p = (async () => {
        const maps: Record<string, THREE.Texture | null> = {};
        await Promise.all(
          em.textures.map(async (t) => {
            const role = embeddedRole(t);
            if (!role || maps[role]) return;
            const blob = new Blob([t.data as BlobPart]);
            maps[role] = await loadTextureFromBlob(blob, role === "map", NPM_TEXTURE_SIZE).catch(() => null);
          })
        );
        return createPbrMaterial(name, maps);
      })();
    } else {
      p = Promise.resolve(src);
    }
    built.set(name, p);
    return p;
  };

  const jobs: Promise<void>[] = [];
  group.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    jobs.push(
      Promise.all(mats.map((m) => (m ? build(m) : Promise.resolve(m)))).then((next) => {
        mesh.material = Array.isArray(mesh.material) ? next : next[0];
      })
    );
  });
  await Promise.all(jobs);
  const withMaps = embedded.filter((m) => m.textures.length).length;
  log.info(`Вшитых материалов: ${embedded.length}, с картами PBR: ${withMaps}`);
}

/** Тени: всё отбрасывает и принимает, кроме стекла (иначе фасады за ним в черноте). */
export function setupShadows(group: THREE.Object3D): void {
  group.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mesh.castShadow = !mats.every((m) => m?.userData.isGlass);
    mesh.receiveShadow = true;
  });
}

/**
 * Источники света в мировых координатах. Вызывать после позиционирования и updateMatrixWorld.
 * Spot у three.js светит в target (по умолчанию — в начало координат, за 15 км от сцены),
 * поэтому target ставим по направлению -Z самого объекта.
 */
export function extractLights(lightGroup: THREE.Group): THREE.Light[] {
  const lights: THREE.Light[] = [];
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const dir = new THREE.Vector3();

  lightGroup.traverse((child) => {
    const isLight = (child as THREE.Object3D & { isLight?: boolean }).isLight;
    const name = child.name.toLowerCase();
    let light: THREE.Light | null = null;
    if (isLight) {
      const src = child as THREE.Light;
      light = src.clone() as THREE.Light;
    } else if (name.includes("omni") || name.includes("point")) {
      light = new THREE.PointLight(0xfff1d6, 1, 30, 2);
    } else if (name.includes("spot")) {
      light = new THREE.SpotLight(0xfff1d6, 1, 40, Math.PI / 5, 0.6, 2);
    }
    if (!light) return;
    child.getWorldPosition(pos);
    child.getWorldQuaternion(quat);
    light.name = child.name;
    light.position.copy(pos);
    light.quaternion.copy(quat);
    light.scale.set(1, 1, 1);
    // three.js считает в канделах: значения из FBX (~1) ночью не видны вовсе.
    light.intensity = Math.max(light.intensity, 60);
    const spot = light as THREE.SpotLight;
    if (spot.isSpotLight) {
      dir.set(0, 0, -1).applyQuaternion(quat);
      spot.target = new THREE.Object3D();
      spot.target.position.copy(pos).addScaledVector(dir, 10);
    }
    lights.push(light);
  });

  log.info(`Источников света из FBX: ${lights.length}`);
  return lights;
}

/** Если центр модели уже далеко от нуля — координаты «запечены» в FBX, сдвигать по geojson второй раз нельзя. */
const BAKED_COORD_THRESHOLD = 1000;

export function applyGeoPositionSmart(group: THREE.Group, geo: GeoJsonData | null, label: string): void {
  if (!geo) return;
  group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(group);
  if (box.isEmpty()) {
    const v = new THREE.Vector3();
    group.traverse((o) => {
      o.getWorldPosition(v);
      box.expandByPoint(v);
    });
  }
  if (!box.isEmpty()) {
    const c = box.getCenter(new THREE.Vector3());
    const s = box.getSize(new THREE.Vector3());
    log.info(
      `${label}: центр (${c.x.toFixed(0)}, ${c.y.toFixed(0)}, ${c.z.toFixed(0)}), размер ${s.x.toFixed(0)}×${s.y.toFixed(0)}×${s.z.toFixed(0)}`
    );
    if (Math.abs(c.x) > BAKED_COORD_THRESHOLD || Math.abs(c.z) > BAKED_COORD_THRESHOLD) {
      log.info(`${label}: координаты уже внутри FBX — сдвиг по geojson не применяется`);
      return;
    }
  }
  applyGeoPosition(group, geo);
}

/** WebGL ограничивает число uniform-ов шейдера: сотни источников света ломают ВСЕ материалы. */
export const MAX_SCENE_LIGHTS = 24;

export function limitLights(lights: THREE.Light[], max = MAX_SCENE_LIGHTS): THREE.Light[] {
  if (lights.length <= max) return lights;
  log.warn(`Источников света ${lights.length} — показываю ${max} (лимит видеокарты)`);
  const out: THREE.Light[] = [];
  for (let i = 0; i < max; i++) out.push(lights[Math.floor((i * lights.length) / max)]);
  return out;
}

export function applyGeoPosition(group: THREE.Group, geo: GeoJsonData | null): void {
  if (!geo || !geo.features?.length) return;
  const feature = geo.features[0];
  let coords: unknown = feature.geometry?.coordinates;
  while (Array.isArray(coords) && Array.isArray(coords[0])) coords = coords[0];
  if (!Array.isArray(coords) || coords.length < 2) return;
  // geojson: X — восток, Y — север (как в Blender, Z-up). В three.js Y — вверх, север — это -Z.
  const x = Number(coords[0]);
  const y = Number(coords[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    log.warn("geojson: координаты не число — позиция не применена");
    return;
  }
  const h = Number(coords[2] ?? feature.properties?.h_relief ?? 0) || 0;
  log.info(`Позиция из geojson: X=${x}, Y=${y}, отметка рельефа ${h} м`);
  group.position.set(x, h, -y);
}

export function collectGlassParams(geo: GeoJsonData | null): Record<string, GlassParams> {
  const result: Record<string, GlassParams> = {};
  if (!geo?.features) return result;
  for (const f of geo.features) {
    if (!f.Glasses) continue;
    for (const glassObj of f.Glasses) {
      for (const [matName, params] of Object.entries(glassObj)) {
        result[matName] = params;
      }
    }
  }
  if (Object.keys(result).length) {
    log.info(`Параметры стекла: ${Object.keys(result).join(", ")}`);
  }
  return result;
}

export async function loadGeoJson(url: string): Promise<GeoJsonData | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as GeoJsonData;
  } catch {
    return null;
  }
}
