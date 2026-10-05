import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { groupUdimTextures, createMaterialFromTextures, applyGlassParams } from "./textureUtils";
import { GeoJsonData, GlassParams } from "./types";
import { log } from "./logger";

const fbxLoader = new FBXLoader();

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

export async function applyExternalTextures(
  group: THREE.Group,
  textureFiles: { name: string; url: string }[],
  glassMap: Record<string, GlassParams> = {}
): Promise<void> {
  if (!textureFiles.length) {
    log.info("Внешних текстур нет — используем вложенные в FBX");
    // Still apply glass params if we have them
    if (Object.keys(glassMap).length) {
      group.traverse((child) => {
        if (!(child as THREE.Mesh).isMesh) return;
        const mesh = child as THREE.Mesh;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const next = mats.map((m) => {
          if (!m) return m;
          const name = m.name || "";
          if (!name) return m;
          const key = Object.keys(glassMap).find(
            (k) => name.includes(k) || k.includes(name) || name.toLowerCase().includes("glass")
          );
          if (key) return applyGlassParams(m, glassMap[key]);
          return m;
        });
        mesh.material = Array.isArray(mesh.material) ? next : next[0];
      });
    }
    return;
  }

  const groups = groupUdimTextures(textureFiles);
  const materials = new Map<string, THREE.Material>();

  group.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach((m) => {
        if (m && m.name) materials.set(m.name, m);
      });
    }
  });

  log.info(`Материалов в модели: ${materials.size}, внешних текстур: ${textureFiles.length}`);

  for (const [matName, oldMat] of Array.from(materials.entries())) {
    const isGlass =
      matName.toLowerCase().includes("glass") ||
      Object.keys(glassMap).some((k) => matName.includes(k) || k.includes(matName));

    let glassParams: GlassParams | undefined;
    if (isGlass) {
      for (const [key, val] of Object.entries(glassMap)) {
        if (matName.includes(key) || key.includes(matName) || matName.toLowerCase().includes("glass")) {
          glassParams = val;
          break;
        }
      }
      if (!glassParams && Object.keys(glassMap).length) {
        glassParams = Object.values(glassMap)[0];
      }
    }

    try {
      const own = textureFiles.filter((t) => t.name.toLowerCase().includes(matName.toLowerCase()));
      const matGroups = own.length ? groupUdimTextures(own) : groups;
      const newMat = await createMaterialFromTextures(matGroups, isGlass, glassParams);
      group.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh;
          if (Array.isArray(mesh.material)) {
            mesh.material = mesh.material.map((m) => (m && m.name === matName ? newMat : m));
          } else if (mesh.material && mesh.material.name === matName) {
            mesh.material = newMat;
          }
        }
      });
    } catch (e) {
      log.warn(`Текстуры не применились к материалу ${matName}`, e);
      if (isGlass && glassParams) {
        const glassMat = applyGlassParams(oldMat, glassParams);
        group.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            const mesh = child as THREE.Mesh;
            if (Array.isArray(mesh.material)) {
              mesh.material = mesh.material.map((m) => (m && m.name === matName ? glassMat : m));
            } else if (mesh.material && mesh.material.name === matName) {
              mesh.material = glassMat;
            }
          }
        });
      }
    }
  }
}

export function extractLights(lightGroup: THREE.Group): THREE.Light[] {
  const lights: THREE.Light[] = [];

  lightGroup.traverse((child) => {
    if ((child as THREE.Object3D & { isLight?: boolean }).isLight) {
      lights.push(child as THREE.Light);
      return;
    }

    const name = child.name.toLowerCase();
    if (name.includes("omni") || name.includes("point")) {
      const light = new THREE.PointLight(0xffffff, 1, 80);
      light.position.copy(child.position);
      light.rotation.copy(child.rotation);
      light.scale.copy(child.scale);
      light.name = child.name;
      lights.push(light);
    } else if (name.includes("spot")) {
      const light = new THREE.SpotLight(0xffffff, 1, 80, Math.PI / 6, 0.5);
      light.position.copy(child.position);
      light.rotation.copy(child.rotation);
      light.name = child.name;
      lights.push(light);
    }
  });

  log.info(`Источников света из FBX: ${lights.length}`, lights.map((l) => l.name));
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
  const x = Number(coords[0]);
  const z = Number(coords[1]);
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    log.warn("geojson: координаты не число — позиция не применена");
    return;
  }
  log.info(`Позиция из geojson: x=${x}, z=${z}`);
  group.position.set(x, 0, z);
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
