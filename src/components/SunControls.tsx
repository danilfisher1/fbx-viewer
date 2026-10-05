"use client";

import { SunPreset, SunState } from "@/lib/types";
import { SUN_PRESETS } from "@/lib/sunPresets";

interface Props {
  sun: SunState;
  onChange: (s: SunState) => void;
}

const PRESET_LABELS: Record<SunPreset, string> = {
  morning: "Утро",
  day: "День",
  evening: "Вечер",
  night: "Ночь",
};

export default function SunControls({ sun, onChange }: Props) {
  const setPreset = (preset: SunPreset) => {
    onChange({ preset, ...SUN_PRESETS[preset] });
  };

  return (
    <div className="panel sun-panel">
      <div className="panel-title">Солнце</div>
      <div className="preset-row">
        {(Object.keys(PRESET_LABELS) as SunPreset[]).map((p) => (
          <button key={p} className={sun.preset === p ? "active" : ""} onClick={() => setPreset(p)}>
            {PRESET_LABELS[p]}
          </button>
        ))}
      </div>
      <label>
        Азимут ({Math.round(sun.azimuth)}°)
        <input
          type="range"
          min={0}
          max={360}
          value={sun.azimuth}
          onChange={(e) => onChange({ ...sun, azimuth: Number(e.target.value) })}
        />
      </label>
      <label>
        Высота ({Math.round(sun.elevation)}°)
        <input
          type="range"
          min={0}
          max={89}
          value={sun.elevation}
          onChange={(e) => onChange({ ...sun, elevation: Number(e.target.value) })}
        />
      </label>
      <label>
        Интенсивность ({sun.intensity.toFixed(1)})
        <input
          type="range"
          min={0}
          max={5}
          step={0.1}
          value={sun.intensity}
          onChange={(e) => onChange({ ...sun, intensity: Number(e.target.value) })}
        />
      </label>
    </div>
  );
}
