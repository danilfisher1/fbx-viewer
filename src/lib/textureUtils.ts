import * as THREE from "three";
import { GlassParams } from "./types";

const textureLoader = new THREE.TextureLoader();

export function loadTexture(url: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    textureLoader.load(
      url,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.flipY = false;
        resolve(tex);
      },
      undefined,
      reject
    );
  });
}

export function loadTextureLinear(url: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    textureLoader.load(
      url,
      (tex) => {
        tex.colorSpace = THREE.LinearSRGBColorSpace;
        tex.flipY = false;
        resolve(tex);
      },
      undefined,
      reject
    );
  });
}

export function getUdimTile(filename: string): number | null {
  const match = filename.match(/\.(\d{4})\.(png|jpg|jpeg|tga|webp)$/i);
  if (match) return parseInt(match[1], 10);
  return null;
}

export function groupUdimTextures(
  textureFiles: { name: string; url: string }[]
): Record<string, Record<number, string>> {
  const result: Record<string, Record<number, string>> = {
    diffuse: {},
    normal: {},
    erm: {},
    roughness: {},
    metallic: {},
    ao: {},
    opacity: {},
  };

  for (const t of textureFiles) {
    const tile = getUdimTile(t.name);
    const lower = t.name.toLowerCase();
    let mapType: string | null = null;

    if (lower.includes("diffuse") || lower.includes("_d_") || lower.includes("albedo") || lower.includes("basecolor")) {
      mapType = "diffuse";
    } else if (lower.includes("normal") || lower.includes("_n_")) {
      mapType = "normal";
    } else if (lower.includes("erm")) {
      mapType = "erm";
    } else if (lower.includes("roughness") || lower.includes("_r_")) {
      mapType = "roughness";
    } else if (lower.includes("metallic") || lower.includes("metalness") || lower.includes("_m_")) {
      mapType = "metallic";
    } else if (lower.includes("opacity") || lower.includes("_o_") || lower.includes("alpha")) {
      mapType = "opacity";
    } else if (lower.includes("ao") || lower.includes("occlusion")) {
      mapType = "ao";
    }

    if (mapType) {
      const key = tile ?? 1001;
      if (!result[mapType]) result[mapType] = {};
      result[mapType][key] = t.url;
    }
  }

  return result;
}

export async function createMaterialFromTextures(
  groups: Record<string, Record<number, string>>,
  isGlass = false,
  glassParams?: GlassParams
): Promise<THREE.Material> {
  const maps: Record<string, THREE.Texture | null> = {
    map: null,
    normalMap: null,
    roughnessMap: null,
    metalnessMap: null,
    aoMap: null,
    alphaMap: null,
  };

  const pick = (obj: Record<number, string>) => {
    if (obj[1001]) return obj[1001];
    const keys = Object.keys(obj).map(Number).sort((a, b) => a - b);
    return keys.length ? obj[keys[0]] : null;
  };

  try {
    if (groups.diffuse && Object.keys(groups.diffuse).length) {
      const url = pick(groups.diffuse);
      if (url) maps.map = await loadTexture(url);
    }
    if (groups.normal && Object.keys(groups.normal).length) {
      const url = pick(groups.normal);
      if (url) maps.normalMap = await loadTextureLinear(url);
    }
    if (groups.roughness && Object.keys(groups.roughness).length) {
      const url = pick(groups.roughness);
      if (url) maps.roughnessMap = await loadTextureLinear(url);
    }
    if (groups.metallic && Object.keys(groups.metallic).length) {
      const url = pick(groups.metallic);
      if (url) maps.metalnessMap = await loadTextureLinear(url);
    }
    if (groups.ao && Object.keys(groups.ao).length) {
      const url = pick(groups.ao);
      if (url) maps.aoMap = await loadTextureLinear(url);
    }
    if (groups.opacity && Object.keys(groups.opacity).length) {
      const url = pick(groups.opacity);
      if (url) maps.alphaMap = await loadTextureLinear(url);
    }
    if (groups.erm && Object.keys(groups.erm).length && !maps.roughnessMap) {
      const url = pick(groups.erm);
      if (url) maps.roughnessMap = await loadTextureLinear(url);
    }
  } catch {
    /* keep partial maps */
  }

  if (isGlass && glassParams) {
    const c = glassParams.color_RGB;
    const mat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(c.Red / 255, c.Green / 255, c.Blue / 255),
      transparent: true,
      opacity: 1 - glassParams.transparency,
      roughness: glassParams.roughness,
      metalness: glassParams.metallicity,
      transmission: glassParams.transparency,
      ior: glassParams.refraction,
      thickness: 0.5,
      side: THREE.DoubleSide,
    });
    if (maps.map) mat.map = maps.map;
    if (maps.normalMap) mat.normalMap = maps.normalMap;
    return mat;
  }

  return new THREE.MeshStandardMaterial({
    map: maps.map,
    normalMap: maps.normalMap,
    roughnessMap: maps.roughnessMap,
    metalnessMap: maps.metalnessMap,
    aoMap: maps.aoMap,
    alphaMap: maps.alphaMap,
    transparent: !!maps.alphaMap,
    side: THREE.DoubleSide,
    roughness: maps.roughnessMap ? 1 : 0.7,
    metalness: maps.metalnessMap ? 1 : 0.0,
  });
}

export function applyGlassParams(material: THREE.Material, params: GlassParams): THREE.MeshPhysicalMaterial {
  const c = params.color_RGB;
  const mat = new THREE.MeshPhysicalMaterial({
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
  const anyMat = material as THREE.MeshStandardMaterial;
  if (anyMat.map) mat.map = anyMat.map;
  if (anyMat.normalMap) mat.normalMap = anyMat.normalMap;
  return mat;
}
