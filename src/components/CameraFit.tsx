"use client";

import { useEffect, useRef } from "react";
import { useThree } from "@react-three/fiber";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import * as THREE from "three";
import { log } from "@/lib/logger";

interface Props {
  fitTrigger: number;
  padding?: number;
}

export default function CameraFit({ fitTrigger, padding = 1.6 }: Props) {
  const { scene, camera, controls } = useThree();
  const lastTrigger = useRef(0);

  useEffect(() => {
    if (fitTrigger === 0 || fitTrigger === lastTrigger.current) return;
    const id = requestAnimationFrame(() => {
      lastTrigger.current = fitTrigger;
      const box = new THREE.Box3();
      let hasMeshes = false;

      scene.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh && obj.visible) {
          if (obj.type === "AxesHelper") return;
          const mesh = obj as THREE.Mesh;
          if (!mesh.geometry) return;
          mesh.updateWorldMatrix(true, false);
          const meshBox = new THREE.Box3().setFromObject(mesh);
          if (!meshBox.isEmpty()) {
            box.union(meshBox);
            hasMeshes = true;
          }
        }
      });

      if (!hasMeshes || box.isEmpty()) {
        log.warn("Автокадр: мешей не найдено");
        return;
      }

      const center = new THREE.Vector3();
      const size = new THREE.Vector3();
      box.getCenter(center);
      box.getSize(size);

      const maxDim = Math.max(size.x, size.y, size.z, 1);
      const fov = ((camera as THREE.PerspectiveCamera).fov * Math.PI) / 180;
      let distance = (maxDim / (2 * Math.tan(fov / 2))) * padding;
      distance = Math.max(distance, 10);
      distance = Math.min(distance, 5000);

      log.info(
        `Автокадр: центр (${center.x.toFixed(1)}, ${center.y.toFixed(1)}, ${center.z.toFixed(1)}) размер ${maxDim.toFixed(1)} м, дистанция ${distance.toFixed(1)}`
      );

      const direction = new THREE.Vector3(0.7, 0.55, 0.7).normalize();
      const newPos = center.clone().add(direction.multiplyScalar(distance));

      camera.position.copy(newPos);
      camera.near = Math.max(0.1, distance / 1000);
      camera.far = Math.max(5000, distance * 10);
      camera.updateProjectionMatrix();
      camera.lookAt(center);

      const orbit = controls as unknown as OrbitControlsImpl | null;
      if (orbit && typeof orbit.target !== "undefined") {
        orbit.target.copy(center);
        orbit.minDistance = Math.max(1, maxDim * 0.05);
        orbit.maxDistance = Math.max(800, distance * 4);
        orbit.update();
      }
    });

    return () => cancelAnimationFrame(id);
  }, [fitTrigger, scene, camera, controls, padding]);

  return null;
}
