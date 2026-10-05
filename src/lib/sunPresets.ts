import { SunPreset, SunState } from "./types";

export const SUN_PRESETS: Record<SunPreset, Omit<SunState, "preset">> = {
  morning: { azimuth: 90, elevation: 25, intensity: 1.4, color: "#ffe0b0" },
  day: { azimuth: 180, elevation: 60, intensity: 2.2, color: "#ffffff" },
  evening: { azimuth: 270, elevation: 20, intensity: 1.3, color: "#ff9a5a" },
  night: { azimuth: 0, elevation: 5, intensity: 0.15, color: "#a0b0ff" },
};

export function sunDirection(azimuthDeg: number, elevationDeg: number): [number, number, number] {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  return [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
}
