export interface GlassParams {
  color_RGB: { Red: number; Green: number; Blue: number };
  transparency: number;
  refraction: number;
  roughness: number;
  metallicity: number;
}

export interface GeoJsonFeature {
  type: string;
  properties: {
    address?: string;
    okrug?: string;
    rajon?: string;
    name?: string;
    developer?: string;
    designer?: string;
    cadNum?: string;
    FNO_code?: string;
    FNO_name?: string;
    ZU_area?: number;
    h_relief?: number;
    h_otn?: number;
    h_abs?: number;
    s_obsh?: number;
    s_naz?: number;
    s_podz?: number;
    spp_gns?: number;
    act_AGR?: string;
    imageBase64?: string;
    other?: string;
  };
  geometry: {
    type: string;
    coordinates: [number, number] | [number, number, number];
  };
  Glasses?: Array<Record<string, GlassParams>>;
}

export interface GeoJsonData {
  type: string;
  features: GeoJsonFeature[];
}

export type SceneFileType =
  | "vpm"
  | "npm"
  | "ground"
  | "light"
  | "geojson"
  | "texture"
  | "zip"
  | "other";

export interface SceneFileInfo {
  path: string;
  name: string;
  type: SceneFileType;
  baseName?: string;
  branch?: "vpm" | "npm" | "unknown";
}

export interface SceneManifest {
  sceneId: string;
  files: SceneFileInfo[];
  vpmModels: SceneFileInfo[];
  npmModels: SceneFileInfo[];
  groundModels: SceneFileInfo[];
  lightFiles: SceneFileInfo[];
  geojsonFiles: SceneFileInfo[];
}

export type SunPreset = "morning" | "day" | "evening" | "night";

export interface SunState {
  preset: SunPreset;
  azimuth: number;
  elevation: number;
  intensity: number;
  color: string;
}

export type LoadPhase = "scan" | "unzip" | "classify" | "models" | "done" | "idle";

export interface LoadProgress {
  phase: LoadPhase;
  percent: number;
  message: string;
  detail?: string;
}
