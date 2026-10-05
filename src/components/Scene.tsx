"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { EffectComposer, N8AO, Bloom, ToneMapping } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import { Suspense, useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { Sky } from "three/addons/objects/Sky.js";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { log } from "@/lib/logger";
import LocalModelLoader, { SceneBounds } from "./LocalModelLoader";
import CameraFit from "./CameraFit";
import FlyControls from "./FlyControls";
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

const SKY_PARAMS = { turbidity: 3, rayleigh: 1.2, mieCoefficient: 0.004, mieDirectionalG: 0.8 };

function makeSky(): Sky {
  const sky = new Sky();
  const u = sky.material.uniforms;
  u.turbidity.value = SKY_PARAMS.turbidity;
  u.rayleigh.value = SKY_PARAMS.rayleigh;
  u.mieCoefficient.value = SKY_PARAMS.mieCoefficient;
  u.mieDirectionalG.value = SKY_PARAMS.mieDirectionalG;
  return sky;
}

/**
 * HDRI окружения — встроенные карты Blender Material Preview (CC0, Poly Haven), лежат в public/hdri.
 * Дают рассеянный свет и то, что отражают зеркальные окна НПМ и металл — как в Blender.
 */
const HDRI_BY_PRESET: Record<SunState["preset"], string> = {
  morning: "/hdri/sunrise.exr",
  day: "/hdri/forest.exr",
  evening: "/hdri/sunset.exr",
  night: "/hdri/night.exr",
};
const ENV_INTENSITY: Record<SunState["preset"], number> = { morning: 0.6, day: 0.6, evening: 0.6, night: 0.25 };

const exrLoader = new EXRLoader();
const hdriCache = new Map<string, Promise<THREE.DataTexture>>();
function loadHdri(url: string): Promise<THREE.DataTexture> {
  let p = hdriCache.get(url);
  if (!p) {
    p = exrLoader.loadAsync(url).then((t) => {
      t.mapping = THREE.EquirectangularReflectionMapping;
      return t;
    });
    hdriCache.set(url, p);
  }
  return p;
}

/**
 * Окружение: видимое физическое небо с облаками вокруг камеры (фон) +
 * HDRI-карта для освещения и отражений (Sky Light в терминах движка).
 */
function EnvironmentSystem({ sun }: { sun: SunState }) {
  const { gl, scene } = useThree();
  const [sky] = useState(makeSky);
  const night = sun.preset === "night";

  useEffect(() => {
    sky.scale.setScalar(12000);
    sky.userData.noFit = true;
    scene.add(sky);
    return () => {
      scene.remove(sky);
    };
  }, [scene, sky]);

  useEffect(() => {
    const [x, y, z] = sunDirection(sun.azimuth, sun.elevation);
    sky.material.uniforms.sunPosition.value.set(x, y, z);
    sky.visible = !night;
    scene.background = night ? new THREE.Color("#05070d") : null;
    scene.fog = null;
  }, [scene, sky, sun.azimuth, sun.elevation, night]);

  useEffect(() => {
    let disposed = false;
    let rt: THREE.WebGLRenderTarget | null = null;
    loadHdri(HDRI_BY_PRESET[sun.preset])
      .then((tex) => {
        if (disposed) return;
        const pmrem = new THREE.PMREMGenerator(gl);
        rt = pmrem.fromEquirectangular(tex);
        pmrem.dispose();
        scene.environment = rt.texture;
        scene.environmentIntensity = ENV_INTENSITY[sun.preset];
      })
      .catch((e) => log.warn("HDRI окружения не загрузилось", e));
    return () => {
      disposed = true;
      if (rt && scene.environment === rt.texture) scene.environment = null;
      rt?.dispose();
    };
  }, [gl, scene, sun.preset]);

  // Небо центрировано на камере, иначе на 15 км от начала координат упрётся в far.
  useFrame(({ camera }) => {
    sky.position.copy(camera.position);
  });
  return null;
}

/**
 * Солнце с тенями. Рамка теневой камеры — по габаритам сцены; карта перерисовывается
 * только при изменениях (сцена статична, тысячи мешей — каждый кадр дорого).
 */
function SunLight({ sun, bounds, showVPM, showNPM }: { sun: SunState; bounds: SceneBounds | null; showVPM: boolean; showNPM: boolean }) {
  const { gl } = useThree();
  const [light] = useState(() => {
    const l = new THREE.DirectionalLight();
    l.castShadow = true;
    l.shadow.mapSize.set(4096, 4096);
    l.shadow.bias = -0.0003;
    l.shadow.normalBias = 0.08;
    return l;
  });
  const dir = useMemo(() => sunDirection(sun.azimuth, sun.elevation), [sun.azimuth, sun.elevation]);

  useEffect(() => {
    gl.shadowMap.autoUpdate = false;
  }, [gl]);

  useEffect(() => {
    const center = bounds ? bounds.box.getCenter(new THREE.Vector3()) : new THREE.Vector3();
    const radius = bounds ? bounds.box.getSize(new THREE.Vector3()).length() / 2 : 100;
    light.target.position.copy(center);
    light.position.set(center.x + dir[0] * radius * 2, center.y + dir[1] * radius * 2, center.z + dir[2] * radius * 2);
    const cam = light.shadow.camera;
    cam.left = cam.bottom = -radius;
    cam.right = cam.top = radius;
    cam.near = 1;
    cam.far = radius * 4;
    cam.updateProjectionMatrix();
    // Пресеты рассчитаны на старое освещение; на фоне неба солнцу нужно ×2.3.
    light.intensity = sun.intensity * 2.3;
    light.color.set(sun.color);
    light.target.updateMatrixWorld();
    gl.shadowMap.needsUpdate = true;
  }, [gl, light, bounds, dir, sun.intensity, sun.color]);

  useEffect(() => {
    gl.shadowMap.needsUpdate = true;
  }, [gl, showVPM, showNPM]);

  return (
    <>
      <primitive object={light} />
      <primitive object={light.target} />
      {sun.preset === "night" && <ambientLight intensity={0.05} color="#8090c0" />}
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
  const [bounds, setBounds] = useState<SceneBounds | null>(null);
  return (
    <Canvas
      dpr={[1, 1.5]}
      shadows={{ type: THREE.PCFSoftShadowMap }}
      camera={{ position: [30, 40, 60], fov: 45, near: 0.1, far: 20000 }}
      gl={{ antialias: false, powerPreference: "high-performance", stencil: false }}
      onCreated={({ gl, scene, camera }) => {
        if (import.meta.env.DEV) Object.assign(window, { __three: { gl, scene, camera } });
        gl.setClearColor("#1a1a1e");
        // Экспозиция для ToneMapping-эффекта (AgX берёт её у рендерера): физическое небо очень яркое.
        gl.toneMappingExposure = 0.75;
      }}
    >
      <EnvironmentSystem sun={sun} />
      <SunLight sun={sun} bounds={bounds} showVPM={showVPM} showNPM={showNPM} />
      <Suspense fallback={null}>
        <LocalModelLoader
          locals={locals}
          manifest={manifest}
          showVPM={showVPM}
          showNPM={showNPM}
          showLights={showLights}
          onGeoLoaded={onGeoLoaded}
          onProgress={onProgress}
          onBounds={setBounds}
        />
      </Suspense>
      <CameraFit fitTrigger={fitTrigger} padding={1.8} />
      <FlyControls />
      {/* Постобработка как в realtime-движке: AO в стыках, мягкий bloom бликов, тонмаппинг AgX (как в Blender). */}
      <EffectComposer multisampling={4} enableNormalPass={false}>
        <N8AO aoRadius={2.5} distanceFalloff={1} intensity={2.5} quality="medium" halfRes />
        <Bloom mipmapBlur luminanceThreshold={4} luminanceSmoothing={0.5} intensity={0.25} />
        <ToneMapping mode={ToneMappingMode.AGX} />
      </EffectComposer>
    </Canvas>
  );
}
