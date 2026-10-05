"use client";

import { GeoJsonData } from "@/lib/types";

interface Props {
  geo: GeoJsonData | null;
  visible: boolean;
  onClose: () => void;
}

export default function InfoPanel({ geo, visible, onClose }: Props) {
  if (!visible || !geo?.features?.length) return null;
  const p = geo.features[0].properties || {};

  const rows: [string, string][] = [];
  if (p.name) rows.push(["Название", p.name]);
  if (p.address) rows.push(["Адрес", p.address]);
  if (p.okrug) rows.push(["Округ", p.okrug]);
  if (p.rajon) rows.push(["Район", p.rajon]);
  if (p.developer) rows.push(["Застройщик", p.developer]);
  if (p.designer) rows.push(["Проектировщик", p.designer]);
  if (p.cadNum) rows.push(["Кадастровый №", p.cadNum]);
  if (p.FNO_name) rows.push(["ФНО", `${p.FNO_name}${p.FNO_code ? ` (${p.FNO_code})` : ""}`]);
  if (p.s_obsh != null) rows.push(["S общая", `${p.s_obsh.toLocaleString("ru-RU")} м²`]);
  if (p.s_naz != null) rows.push(["S наземная", `${p.s_naz.toLocaleString("ru-RU")} м²`]);
  if (p.s_podz != null) rows.push(["S подземная", `${p.s_podz.toLocaleString("ru-RU")} м²`]);
  if (p.h_abs != null) rows.push(["Высота абс.", `${p.h_abs} м`]);
  if (p.ZU_area != null) rows.push(["Площадь ЗУ", `${p.ZU_area} га`]);

  return (
    <div className="panel info-panel">
      <div className="panel-header">
        <span className="panel-title">Информация об объекте</span>
        <button className="close-btn" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="info-body">
        {rows.map(([label, value]) => (
          <div className="info-row" key={label}>
            <span className="label">{label}</span>
            <span className="value">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
