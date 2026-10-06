"use client";

import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

/**
 * Навигация как во вьюпорте Unreal Engine:
 * - ЛКМ / ПКМ зажата + движение мыши — обзор (поворот головы);
 * - WASD — полёт вперёд/влево/назад/вправо, Q/E — вниз/вверх, Shift — ускорение ×3;
 * - колесо мыши — скорость полёта;
 * - СКМ зажата — панорама (сдвиг вбок/вверх).
 * Клавиши читаются по физическому коду (KeyW…), поэтому работают и в русской раскладке.
 */

export const FLY_SPEED_EVENT = "fly-speed";
/** CameraFit сообщает подходящую скорость под размер сцены. */
export const FLY_FIT_EVENT = "fly-fit";
const MIN_SPEED = 0.5;
const MAX_SPEED = 1000;
const LOOK_SENSITIVITY = 0.0025;
const ACCEL = 10; // плавность разгона/торможения

/**
 * Колесо: скорость меняется пропорционально величине прокрутки, а не числу событий.
 * Обычная мышь шлёт ~100 px на щелчок, а MX Master и тачпады в бесшаговом режиме —
 * десятки мелких событий по несколько px: при «×1.15 на событие» скорость улетала до максимума.
 */
const WHEEL_NOTCH_PX = 100; // один щелчок колеса в Chrome/Edge на Windows
const WHEEL_STEP = 1.15; // множитель скорости на один щелчок
const WHEEL_MAX_PX_PER_EVENT = 300; // рывок раскрученного колеса — не больше трёх щелчков за событие
/** Лимит темпа: за окно 0.2 с — не больше ~4 щелчков (×1.75), лишняя прокрутка отбрасывается. */
const WHEEL_WINDOW_MS = 200;
const WHEEL_MAX_PX_PER_WINDOW = 400;

function wheelPixels(e: WheelEvent): number {
  const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 800 : 1; // строки / страницы → px
  return THREE.MathUtils.clamp(e.deltaY * unit, -WHEEL_MAX_PX_PER_EVENT, WHEEL_MAX_PX_PER_EVENT);
}

const MOVE_KEYS: Record<string, [number, number, number]> = {
  KeyW: [0, 0, 1],
  KeyS: [0, 0, -1],
  KeyA: [-1, 0, 0],
  KeyD: [1, 0, 0],
  KeyE: [0, 1, 0],
  KeyQ: [0, -1, 0],
  ArrowUp: [0, 0, 1],
  ArrowDown: [0, 0, -1],
  ArrowLeft: [-1, 0, 0],
  ArrowRight: [1, 0, 0],
};

export default function FlyControls({ initialSpeed = 15 }: { initialSpeed?: number }) {
  const { camera, gl } = useThree();
  const keys = useRef(new Set<string>());
  const speed = useRef(initialSpeed);
  const velocity = useRef(new THREE.Vector3());
  const drag = useRef<{ button: number; yaw: number; pitch: number } | null>(null);
  const wheelWindow = useRef({ start: 0, used: 0 });

  useEffect(() => {
    const el = gl.domElement;
    const euler = new THREE.Euler(0, 0, 0, "YXZ");

    const typing = () => {
      const a = document.activeElement;
      return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || (a as HTMLElement).isContentEditable);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (typing()) return;
      if (MOVE_KEYS[e.code] || e.code.startsWith("Shift")) {
        keys.current.add(e.code);
        if (e.code.startsWith("Arrow")) e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => keys.current.delete(e.code);
    const onBlur = () => keys.current.clear();

    const onPointerDown = (e: PointerEvent) => {
      euler.setFromQuaternion(camera.quaternion, "YXZ");
      drag.current = { button: e.button, yaw: euler.y, pitch: euler.x };
      el.setPointerCapture(e.pointerId);
      el.focus();
    };
    const onPointerMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      if (d.button === 1) {
        // Панорама: сдвиг в плоскости экрана, пропорционально скорости полёта.
        const k = speed.current * 0.01;
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
        camera.position.addScaledVector(right, -e.movementX * k).addScaledVector(up, e.movementY * k);
        return;
      }
      d.yaw -= e.movementX * LOOK_SENSITIVITY;
      d.pitch = THREE.MathUtils.clamp(d.pitch - e.movementY * LOOK_SENSITIVITY, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
      euler.set(d.pitch, d.yaw, 0, "YXZ");
      camera.quaternion.setFromEuler(euler);
    };
    const onPointerUp = (e: PointerEvent) => {
      drag.current = null;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const now = performance.now();
      const win = wheelWindow.current;
      if (now - win.start > WHEEL_WINDOW_MS) {
        win.start = now;
        win.used = 0;
      }
      const px = wheelPixels(e);
      const allowed = Math.min(Math.abs(px), Math.max(0, WHEEL_MAX_PX_PER_WINDOW - win.used));
      if (allowed <= 0) return;
      win.used += allowed;
      const factor = Math.pow(WHEEL_STEP, (-Math.sign(px) * allowed) / WHEEL_NOTCH_PX);
      speed.current = THREE.MathUtils.clamp(speed.current * factor, MIN_SPEED, MAX_SPEED);
      window.dispatchEvent(new CustomEvent(FLY_SPEED_EVENT, { detail: speed.current }));
    };
    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    const onFit = (e: Event) => {
      const v = Number((e as CustomEvent).detail);
      if (!Number.isFinite(v)) return;
      speed.current = THREE.MathUtils.clamp(v, MIN_SPEED, MAX_SPEED);
      velocity.current.set(0, 0, 0);
      window.dispatchEvent(new CustomEvent(FLY_SPEED_EVENT, { detail: speed.current }));
    };
    window.addEventListener(FLY_FIT_EVENT, onFit);

    el.tabIndex = 0;
    el.style.outline = "none";
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("contextmenu", onContextMenu);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener(FLY_FIT_EVENT, onFit);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("contextmenu", onContextMenu);
    };
  }, [camera, gl]);

  const wish = useRef(new THREE.Vector3());
  const tmp = useRef(new THREE.Vector3());
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    const w = wish.current.set(0, 0, 0);
    let boost = 1;
    keys.current.forEach((k) => {
      const m = MOVE_KEYS[k];
      if (m) w.add(tmp.current.set(m[0], m[1], m[2]));
      if (k.startsWith("Shift")) boost = 3;
    });
    // Вперёд/вбок — по направлению взгляда (как в Unreal), вверх/вниз — по мировой вертикали.
    const target = tmp.current.set(0, 0, 0);
    if (w.lengthSq() > 0) {
      w.normalize();
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      target.addScaledVector(forward, w.z).addScaledVector(right, w.x).addScaledVector(THREE.Object3D.DEFAULT_UP, w.y);
      target.multiplyScalar(speed.current * boost);
    }
    velocity.current.lerp(target, 1 - Math.exp(-ACCEL * dt));
    if (velocity.current.lengthSq() > 1e-6) camera.position.addScaledVector(velocity.current, dt);
  });

  return null;
}
