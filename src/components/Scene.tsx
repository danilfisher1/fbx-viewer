"use client";

import { Canvas } from "@react-three/fiber";
import { OrbitControls, Environment, Lightformer } from "@react-three/drei";
import { Suspense, useMemo } from "react";
import * as THREE from "three";
import LocalModelLoader from "./LocalModelLoader";
import CameraFit from "./CameraFit";
import { SceneManifest, SunState, GeoJsonData, LoadProgress } from "@/lib/types";
import { LocalFile } from "@/lib/localFiles";
import { sunDirection } from "@/lib/sunPresets";

interface Props {
  locals: LocalFile[];
  manifest: SceneManifest;
  showVPM: boolean;
  showNPM: boolean;
  showLights: boolean;
  sun: SunState;
  fitTrigger: number;
  onGeoLoaded: (geo: GeoJsonData | null) => void;
  onProgress: (p: LoadProgress) => void;
}

function SunLight({ sun }: { sun: SunState }) {
  const dir = useMemo(() => sunDirection(sun.azimuth, sun.elevation), [sun.azimuth, sun.elevation]);
  const dist = 500;
  return (
    <>
      <directionalLight
        position={[dir[0] * dist, dir[1] * dist, dir[2] * dist]}
        intensity={sun.intensity}
        color={sun.color}
      />
      <ambientLight intensity={sun.preset === "night" ? 0.08 : 0.25} />
      <hemisphereLight args={[sun.preset === "night" ? "#1a1a2e" : "#b1e1ff", "#444", 0.35]} />
    </>
  );
}

export default function Scene({
  locals,
  manifest,
  showVPM,
  showNPM,
  showLights,
  sun,
  fitTrigger,
  onGeoLoaded,
  onProgress,
}: Props) {
  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ position: [30, 40, 60], fov: 45, near: 0.1, far: 20000 }}
      gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.0 }}
      onCreated={({ gl }) => {
        gl.setClearColor("#1a1a1e");
      }}
    >
      <SunLight sun={sun} />
      <Suspense fallback={null}>
        <LocalModelLoader
          locals={locals}
          manifest={manifest}
          showVPM={showVPM}
          showNPM={showNPM}
          showLights={showLights}
          onGeoLoaded={onGeoLoaded}
          onProgress={onProgress}
        />
        {/* Процедурное окружение: не качает HDR из интернета, работает офлайн */}
        <Environment resolution={256} background={false} environmentIntensity={0.35}>
          <Lightformer form="rect" intensity={2} position={[0, 6, -8]} scale={[14, 6, 1]} />
          <Lightformer form="rect" intensity={1} position={[-8, 3, 4]} scale={[6, 6, 1]} />
          <Lightformer form="rect" intensity={1} position={[8, 3, 4]} scale={[6, 6, 1]} />
        </Environment>
      </Suspense>
      <CameraFit fitTrigger={fitTrigger} padding={1.8} />
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.08}
        minDistance={1}
        maxDistance={10000}
        maxPolarAngle={Math.PI * 0.49}
      />
    </Canvas>
  );
}
