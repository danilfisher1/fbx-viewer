"use client";

import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";

/**
 * Снимок вьюпорта для превью ссылки. Читаем canvas в том же кадре сразу после рендера
 * (приоритет выше, чем у EffectComposer), поэтому preserveDrawingBuffer не нужен.
 * Результат — JPEG 1200×630 (формат карточек ссылок), кадрирование «cover» по центру.
 */

export const CAPTURE_REQUEST_EVENT = "fbx-capture-request";
export const CAPTURE_RESULT_EVENT = "fbx-capture-result";

const OUT_W = 1200;
const OUT_H = 630;

export function requestCapture(): Promise<string> {
  return new Promise((resolve, reject) => {
    const onResult = (e: Event) => {
      window.removeEventListener(CAPTURE_RESULT_EVENT, onResult);
      const d = (e as CustomEvent<string | null>).detail;
      if (d) resolve(d);
      else reject(new Error("Снимок не получился"));
    };
    window.addEventListener(CAPTURE_RESULT_EVENT, onResult);
    window.dispatchEvent(new Event(CAPTURE_REQUEST_EVENT));
  });
}

export default function PreviewCapture() {
  const { gl } = useThree();
  const pending = useRef(false);

  useEffect(() => {
    const onRequest = () => {
      pending.current = true;
    };
    window.addEventListener(CAPTURE_REQUEST_EVENT, onRequest);
    return () => window.removeEventListener(CAPTURE_REQUEST_EVENT, onRequest);
  }, []);

  useFrame(() => {
    if (!pending.current) return;
    pending.current = false;
    let result: string | null = null;
    try {
      const src = gl.domElement;
      const out = document.createElement("canvas");
      out.width = OUT_W;
      out.height = OUT_H;
      const ctx = out.getContext("2d")!;
      const scale = Math.max(OUT_W / src.width, OUT_H / src.height);
      const w = src.width * scale;
      const h = src.height * scale;
      ctx.drawImage(src, (OUT_W - w) / 2, (OUT_H - h) / 2, w, h);
      result = out.toDataURL("image/jpeg", 0.86);
    } catch {
      result = null;
    }
    window.dispatchEvent(new CustomEvent(CAPTURE_RESULT_EVENT, { detail: result }));
  }, 2);

  return null;
}
