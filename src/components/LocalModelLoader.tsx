"use client";

import { useEffect, useState } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  loadFBX,
  applyExternalTextures,
  extractLights,
  applyGeoPosition,
  collectGlassParams,
} from "@/lib/fbxLoader";
import { SceneManifest, GeoJsonData, LoadProgress } from "@/lib/types";
import { LocalFile, readGeoJsonFromFile, buildUrlMap } from "@/lib/localFiles";
import { log } from "@/lib/logger";

interface Props {
  locals: LocalFile[];
  manifest: SceneManifest;
  showVPM: boolean;
  showNPM: boolean;
  showLights: boolean;
  onGeoLoaded?: (geo: GeoJsonData | null) => void;
  onProgress?: (p: LoadProgress) => void;
}

export default function LocalModelLoader({
  locals,
  manifest,
  showVPM,
  showNPM,
  showLights,
  onGeoLoaded,
  onProgress,
}: Props) {
  const { scene } = useThree();
  const [root] = useState(() => new THREE.Group());
  const [vpmGroup] = useState(() => new THREE.Group());
  const [npmGroup] = useState(() => new THREE.Group());
  const [lightsGroup] = useState(() => new THREE.Group());

  useEffect(() => {
    scene.add(root);
    root.add(vpmGroup);
    root.add(npmGroup);
    root.add(lightsGroup);
    return () => {
      scene.remove(root);
      [vpmGroup, npmGroup].forEach((g) => {
        while (g.children.length) {
          const c = g.children[0];
          g.remove(c);
          disposeObject(c);
        }
      });
      while (lightsGroup.children.length) lightsGroup.remove(lightsGroup.children[0]);
    };
  }, [scene, root, vpmGroup, npmGroup, lightsGroup]);

  useEffect(() => {
    vpmGroup.visible = showVPM;
  }, [showVPM, vpmGroup]);

  useEffect(() => {
    npmGroup.visible = showNPM;
  }, [showNPM, npmGroup]);

  useEffect(() => {
    lightsGroup.visible = showLights;
  }, [showLights, lightsGroup]);

  useEffect(() => {
    let cancelled = false;

    async function runLoad() {
      if (!locals.length) {
        onProgress?.({ phase: "idle", percent: 0, message: "" });
        return;
      }

      onProgress?.({ phase: "models", percent: 48, message: "Чтение geojson…" });
      const urlMap = buildUrlMap(locals);
      const getUrl = (relPath: string, name?: string) =>
        urlMap.get(relPath) || (name ? urlMap.get(name) : undefined);

      const geoMap = new Map<string, GeoJsonData>();
      let mainGeo: GeoJsonData | null = null;

      for (const g of manifest.geojsonFiles) {
        const local = locals.find((l) => l.relativePath === g.path || l.info.name === g.name);
        if (!local) continue;
        const data = await readGeoJsonFromFile(local.file);
        if (data) {
          geoMap.set(g.path, data);
          if (!mainGeo) mainGeo = data;
          log.ok(`geojson: ${g.name}`);
        }
      }
      if (!cancelled) onGeoLoaded?.(mainGeo);

      const allTextures = locals
        .filter((l) => l.info.type === "texture")
        .map((l) => ({ name: l.info.name, url: l.objectUrl }));

      const vpmAndGround = [...manifest.vpmModels, ...manifest.groundModels];
      const npmList = manifest.npmModels;
      const lightList = manifest.lightFiles;
      const totalJobs = vpmAndGround.length + npmList.length + lightList.length || 1;
      let doneJobs = 0;

      const bump = (label: string, extra?: string) => {
        doneJobs++;
        const percent = 48 + Math.round((doneJobs / totalJobs) * 50);
        onProgress?.({
          phase: "models",
          percent: Math.min(98, percent),
          message: label,
          detail: extra,
        });
      };

      for (let i = 0; i < vpmAndGround.length; i++) {
        if (cancelled) return;
        const model = vpmAndGround[i];
        const url = getUrl(model.path, model.name);
        const label = `ВПМ ${i + 1}/${vpmAndGround.length}: ${model.name}`;
        onProgress?.({ phase: "models", percent: 48 + Math.round((doneJobs / totalJobs) * 50), message: label });
        if (!url) {
          log.warn(`Нет URL для ${model.path}`);
          bump(label, "пропуск");
          continue;
        }
        log.info(label, { path: model.path, size: locals.find((l) => l.relativePath === model.path)?.file.size });
        try {
          const group = await loadFBX(url, (r) => {
            onProgress?.({
              phase: "models",
              percent: 48 + Math.round(((doneJobs + r) / totalJobs) * 50),
              message: label,
              detail: `${Math.round(r * 100)}% файла`,
            });
          });
          if (cancelled) {
            disposeObject(group);
            return;
          }
          let geo: GeoJsonData | null = null;
          for (const [gPath, gData] of Array.from(geoMap.entries())) {
            const folder = model.path.split("/").slice(0, -1).join("/");
            if (gPath.startsWith(folder) || gPath.includes(model.baseName || "")) {
              geo = gData;
              break;
            }
          }
          if (!geo) geo = mainGeo;
          const glassMap = collectGlassParams(geo);
          const relatedTex = allTextures.filter(
            (t) => t.name.includes(model.baseName || "") || t.name.includes((model.baseName || "").replace(/_Main.*/, ""))
          );
          await applyExternalTextures(group, relatedTex.length ? relatedTex : allTextures, glassMap);
          if (cancelled) {
            disposeObject(group);
            return;
          }
          applyGeoPosition(group, geo);

          let meshes = 0;
          const toRemove: THREE.Object3D[] = [];
          group.traverse((c) => {
            if ((c as THREE.Mesh).isMesh) meshes++;
            if (c.name.toLowerCase().startsWith("ucx_")) toRemove.push(c);
          });
          toRemove.forEach((c) => c.parent?.remove(c));
          vpmGroup.add(group);
          log.ok(`${model.name}: meshes=${meshes}, UCX снято=${toRemove.length}`);
        } catch (e) {
          log.error(`Не загрузился ВПМ ${model.path}`, e);
        }
        bump(label);
      }

      for (let i = 0; i < npmList.length; i++) {
        if (cancelled) return;
        const model = npmList[i];
        const url = getUrl(model.path, model.name);
        const label = `НПМ ${i + 1}/${npmList.length}: ${model.name}`;
        if (!url) {
          log.warn(`Нет URL для ${model.path}`);
          bump(label, "пропуск");
          continue;
        }
        log.info(label);
        try {
          const group = await loadFBX(url, (r) => {
            onProgress?.({
              phase: "models",
              percent: 48 + Math.round(((doneJobs + r) / totalJobs) * 50),
              message: label,
              detail: `${Math.round(r * 100)}% файла`,
            });
          });
          await applyExternalTextures(group, allTextures, {});
          if (cancelled) {
            disposeObject(group);
            return;
          }
          let meshes = 0;
          group.traverse((c) => {
            if ((c as THREE.Mesh).isMesh) meshes++;
          });
          npmGroup.add(group);
          log.ok(`${model.name}: meshes=${meshes} (позиция не сдвигается)`);
        } catch (e) {
          log.error(`Не загрузился НПМ ${model.path}`, e);
        }
        bump(label);
      }

      for (const lightFile of lightList) {
        if (cancelled) return;
        const url = getUrl(lightFile.path, lightFile.name);
        const label = `Свет: ${lightFile.name}`;
        if (!url) {
          bump(label, "пропуск");
          continue;
        }
        log.info(label);
        try {
          const lightFbx = await loadFBX(url);
          if (cancelled) return;
          let geo: GeoJsonData | null = null;
          for (const [gPath, gData] of Array.from(geoMap.entries())) {
            if (gPath.includes(lightFile.name.replace(/_Light.*/i, ""))) {
              geo = gData;
              break;
            }
          }
          applyGeoPosition(lightFbx, geo || mainGeo);
          lightFbx.updateMatrixWorld(true);
          const lights = extractLights(lightFbx);
          lights.forEach((l) => {
            l.updateWorldMatrix(true, false);
            lightsGroup.attach(l);
          });
        } catch (e) {
          log.error(`Не загрузился свет ${lightFile.path}`, e);
        }
        bump(label);
      }

      if (!cancelled) {
        onProgress?.({ phase: "done", percent: 100, message: "Готово" });
      }
    }

    async function loadAll() {
      log.group("Загрузка моделей в сцену");
      try {
        await runLoad();
      } catch (e) {
        log.error("Ошибка загрузки сцены", e);
        if (!cancelled) onProgress?.({ phase: "done", percent: 100, message: "Ошибка загрузки — см. лог" });
      } finally {
        log.groupEnd();
      }
    }

    while (vpmGroup.children.length) {
      const c = vpmGroup.children[0];
      vpmGroup.remove(c);
      disposeObject(c);
    }
    while (npmGroup.children.length) {
      const c = npmGroup.children[0];
      npmGroup.remove(c);
      disposeObject(c);
    }
    while (lightsGroup.children.length) {
      lightsGroup.remove(lightsGroup.children[0]);
    }

    loadAll();

    return () => {
      cancelled = true;
    };
  }, [locals, manifest]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

function disposeObject(obj: THREE.Object3D) {
  obj.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach((m) => {
        if (!m) return;
        Object.values(m).forEach((v) => {
          if (v && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose();
        });
        m.dispose();
      });
    }
  });
}
