import * as THREE from "three";
import { GlassParams } from "./types";

/**
 * Текстуры ВПМ — UDIM-наборы `T_<база>_<Карта>_<N>.<тайл>.png` (Diffuse / ERM / Normal).
 * В Blender: Diffuse → Base Color (sRGB), ERM → Separate Color (G → Roughness, B → Metallic),
 * Normal → Normal Map (tangent). three.js читает roughness из G и metalness из B — один ERM
 * подходит в обе карты без перепаковки.
 */

/** Тайлы 2048px десятками съедают гигабайты видеопамяти — ужимаем при загрузке. */
export const MAX_TEXTURE_SIZE = 1024;
const LOAD_CONCURRENCY = 6;

export type MapKind = "diffuse" | "erm" | "normal" | "opacity";

export interface TextureSet {
  key: string;
  maps: Record<MapKind, Map<number, string>>;
}

const KIND_ALIASES: Record<string, MapKind> = {
  diffuse: "diffuse",
  basecolor: "diffuse",
  albedo: "diffuse",
  d: "diffuse",
  erm: "erm",
  normal: "normal",
  n: "normal",
  opacity: "opacity",
  alpha: "opacity",
  o: "opacity",
};

const TEXTURE_RE = /^T_(.+)_([A-Za-z]+)_(\d+)(?:\.(\d{4}))?\.(png|jpe?g|tga|webp)$/i;

export function parseTextureName(name: string): { setKey: string; kind: MapKind; tile: number } | null {
  const m = name.match(TEXTURE_RE);
  if (!m) return null;
  const kind = KIND_ALIASES[m[2].toLowerCase()];
  if (!kind) return null;
  return {
    setKey: `${m[1]}_${Number(m[3])}`.toLowerCase(),
    kind,
    tile: m[4] ? Number(m[4]) : 1001,
  };
}

export function buildTextureSets(files: { name: string; url: string }[]): Map<string, TextureSet> {
  const sets = new Map<string, TextureSet>();
  for (const f of files) {
    const p = parseTextureName(f.name);
    if (!p) continue;
    let set = sets.get(p.setKey);
    if (!set) {
      set = { key: p.setKey, maps: { diffuse: new Map(), erm: new Map(), normal: new Map(), opacity: new Map() } };
      sets.set(p.setKey, set);
    }
    set.maps[p.kind].set(p.tile, f.url);
  }
  return sets;
}

/** `M_<база>_Main_1` / `M_<база>_Ground_1` / `M_<база>_Main` → ключ набора `<база>_1`. */
export function materialSetKey(matName: string): string | null {
  const m = matName.match(/^M_(.+?)(?:_Main[A-Za-z]*)?(?:_(\d+))?$/i);
  if (!m) return null;
  return `${m[1]}_${Number(m[2] ?? 1)}`.toLowerCase();
}

export function isGlassMaterialName(name: string): boolean {
  return /glass/i.test(name);
}

/** Номер UDIM-тайла треугольника по центру его UV. */
export function udimTile(u: number, v: number): number {
  return 1001 + Math.floor(u) + 10 * Math.floor(v);
}

// --- загрузка текстур -------------------------------------------------------

let active = 0;
const queue: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= LOAD_CONCURRENCY) await new Promise<void>((r) => queue.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}

/**
 * FBX-UV идут по конвенции OpenGL (v=0 внизу), поэтому картинку переворачиваем по Y
 * (как делает сам FBXLoader). ImageBitmap игнорирует texture.flipY — переворот делаем при декодировании.
 */
export function loadTexture(url: string, srgb: boolean): Promise<THREE.Texture> {
  return limited(async () => {
    const blob = await (await fetch(url)).blob();
    let bmp = await createImageBitmap(blob, {
      imageOrientation: "flipY",
      premultiplyAlpha: "none",
      colorSpaceConversion: "none",
    });
    const scale = Math.min(1, MAX_TEXTURE_SIZE / Math.max(bmp.width, bmp.height));
    if (scale < 1) {
      const small = await createImageBitmap(bmp, {
        resizeWidth: Math.round(bmp.width * scale),
        resizeHeight: Math.round(bmp.height * scale),
        resizeQuality: "high",
        premultiplyAlpha: "none",
        colorSpaceConversion: "none",
      });
      bmp.close();
      bmp = small;
    }
    const tex = new THREE.Texture(bmp as unknown as HTMLImageElement);
    tex.flipY = false;
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    return tex;
  });
}

const textureCache = new Map<string, Promise<THREE.Texture>>();
function cachedTexture(url: string, srgb: boolean): Promise<THREE.Texture> {
  let p = textureCache.get(url);
  if (!p) {
    p = loadTexture(url, srgb);
    textureCache.set(url, p);
  }
  return p;
}

/** Вызывать при сбросе сцены: blob-URL уже отозваны, кэш должен уйти вместе с ними. */
export function clearTextureCache() {
  textureCache.clear();
}

/** Материал одного UDIM-тайла набора — повторяет ноды Blender. */
export async function createTileMaterial(set: TextureSet, tile: number): Promise<THREE.MeshStandardMaterial> {
  const url = (k: MapKind) => set.maps[k].get(tile);
  const load = (k: MapKind, srgb: boolean) => {
    const u = url(k);
    return u ? cachedTexture(u, srgb).catch(() => null) : Promise.resolve(null);
  };
  const [map, erm, normalMap, alphaMap] = await Promise.all([
    load("diffuse", true),
    load("erm", false),
    load("normal", false),
    load("opacity", false),
  ]);
  const mat = new THREE.MeshStandardMaterial({
    name: `${set.key}.${tile}`,
    map,
    normalMap,
    roughnessMap: erm,
    metalnessMap: erm,
    roughness: erm ? 1 : 0.8,
    metalness: erm ? 1 : 0,
    alphaMap,
    transparent: !!alphaMap,
    alphaTest: alphaMap ? 0.5 : 0,
    side: THREE.DoubleSide,
  });
  if (!map) mat.color.set(0xbdbdbd);
  return mat;
}

export function createGlassMaterial(params: GlassParams, name = ""): THREE.MeshPhysicalMaterial {
  const c = params.color_RGB;
  return new THREE.MeshPhysicalMaterial({
    name,
    color: new THREE.Color(c.Red / 255, c.Green / 255, c.Blue / 255),
    transparent: true,
    opacity: 1 - params.transparency,
    roughness: params.roughness,
    metalness: params.metallicity,
    transmission: Math.min(params.transparency, 0.95),
    ior: params.refraction || 1.45,
    thickness: 0.8,
    side: THREE.DoubleSide,
  });
}
