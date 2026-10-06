"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import Scene from "./Scene";
import { FLY_SPEED_EVENT } from "./FlyControls";
import SunControls from "./SunControls";
import InfoPanel from "./InfoPanel";
import { LocalFile, ingestFiles, revokeAll } from "@/lib/localFiles";
import { SceneManifest, SunState, GeoJsonData, LoadProgress } from "@/lib/types";
import { SUN_PRESETS } from "@/lib/sunPresets";
import { log, LogEntry, subscribeLogs, formatBytes } from "@/lib/logger";
import { downloadYandexProject } from "@/lib/yandexDisk";
import { canEditPreview, savePreview, type PublicProject } from "@/lib/projects";
import { requestCapture } from "./PreviewCapture";

interface ViewerUIProps {
  /** Проект по ссылке /p/<slug>: модель скачивается с Яндекс Диска автоматически. */
  remote?: PublicProject;
}

export default function ViewerUI({ remote }: ViewerUIProps = {}) {
  const [locals, setLocals] = useState<LocalFile[]>([]);
  const [manifest, setManifest] = useState<SceneManifest | null>(null);
  const [progress, setProgress] = useState<LoadProgress>({
    phase: "idle",
    percent: 0,
    message: "",
  });
  const [showVPM, setShowVPM] = useState(true);
  const [showNPM, setShowNPM] = useState(false);
  const [showLights, setShowLights] = useState(true);
  const [showInfo, setShowInfo] = useState(false);
  const [showLog, setShowLog] = useState(true);
  const [geo, setGeo] = useState<GeoJsonData | null>(null);
  const [fitTrigger, setFitTrigger] = useState(0);
  const [flySpeed, setFlySpeed] = useState<number | null>(null);

  useEffect(() => {
    const onSpeed = (e: Event) => setFlySpeed(Number((e as CustomEvent).detail));
    window.addEventListener(FLY_SPEED_EVENT, onSpeed);
    return () => window.removeEventListener(FLY_SPEED_EVENT, onSpeed);
  }, []);
  const [dragOver, setDragOver] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);

  const folderInputRef = useRef<HTMLInputElement>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const localsRef = useRef<LocalFile[]>([]);

  const [sun, setSun] = useState<SunState>({ preset: "day", ...SUN_PRESETS.day });

  useEffect(() => {
    return subscribeLogs((entry) => {
      setLogs((prev) => [...prev.slice(-200), entry]);
    });
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  useEffect(() => {
    localsRef.current = locals;
  }, [locals]);

  // Освободить blob-URL при уходе со страницы
  useEffect(() => () => revokeAll(localsRef.current), []);

  const requestFit = useCallback(() => setFitTrigger((n) => n + 1), []);

  const handleFiles = useCallback(
    async (fileList: FileList | File[]) => {
      setBusy(true);
      setLogs([]);
      setProgress({ phase: "scan", percent: 1, message: "Старт…" });
      log.info("Выбор папки / файлов начат");

      revokeAll(localsRef.current);
      localsRef.current = [];
      setLocals([]);
      setManifest(null);
      setGeo(null);

      try {
        const { locals: next, manifest: m } = await ingestFiles(fileList, setProgress);
        setLocals(next);
        setManifest(m);

        const hasVpm = m.vpmModels.length + m.groundModels.length > 0;
        const hasNpm = m.npmModels.length > 0;
        if (!hasVpm && hasNpm) {
          setShowVPM(false);
          setShowNPM(true);
        } else {
          setShowVPM(true);
          setShowNPM(false);
        }

        if (m.vpmModels.length + m.npmModels.length === 0) {
          setBusy(false);
          setProgress({
            phase: "done",
            percent: 100,
            message: "FBX не найдены — смотри лог",
          });
        }
      } catch (e) {
        log.error("Ошибка обработки папки", e);
        setBusy(false);
        setProgress({ phase: "idle", percent: 0, message: "Ошибка — см. консоль" });
      }
    },
    []
  );

  // Админ на странице проекта может снять превью для карточки ссылки (как «В кадр»).
  const [isAdmin, setIsAdmin] = useState(false);
  const [previewState, setPreviewState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [fitPadding, setFitPadding] = useState(1.8);
  useEffect(() => {
    if (remote) canEditPreview().then(setIsAdmin).catch(() => setIsAdmin(false));
  }, [remote]);
  const makePreview = useCallback(async () => {
    if (!remote) return;
    setPreviewState("busy");
    try {
      setShowLog(false);
      // Карточка 1200×630 вырезается из центра окна: чем уже окно, тем больше срежется сверху/снизу,
      // поэтому запас вокруг модели считаем от пропорций окна (широкий экран — модель крупнее).
      const keepHeight = Math.min(1, window.innerWidth / window.innerHeight / (1200 / 630));
      setFitPadding(1.1 / keepHeight);
      requestFit();
      await new Promise((r) => setTimeout(r, 900)); // камера встала, тени и AO отрисовались
      const dataUrl = await requestCapture();
      setFitPadding(1.8);
      await savePreview({ data: { slug: remote.slug, dataUrl } });
      log.ok("Превью ссылки сохранено");
      setPreviewState("done");
    } catch (e) {
      log.error("Не удалось сохранить превью", e);
      setPreviewState("error");
    }
    setTimeout(() => setPreviewState("idle"), 2500);
  }, [remote, requestFit]);

  // Проект по ссылке: скачать с Яндекс Диска и загрузить как выбранную папку.
  const remoteStarted = useRef(false);
  useEffect(() => {
    if (!remote || remoteStarted.current) return;
    remoteStarted.current = true;
    setBusy(true);
    setProgress({ phase: "scan", percent: 0, message: `Скачивание «${remote.name}» с Яндекс Диска…` });
    downloadYandexProject(remote.yandexUrl, ({ loaded, total, file }) => {
      setProgress({
        phase: "scan",
        percent: total ? Math.round((loaded / total) * 100) : 0,
        message: `Скачивание «${remote.name}»: ${formatBytes(loaded)} из ${formatBytes(total)}`,
        detail: file,
      });
    })
      .then((files) => handleFiles(files))
      .catch((e) => {
        log.error("Не удалось скачать проект с Яндекс Диска", e);
        setBusy(false);
        setProgress({ phase: "done", percent: 100, message: `Ошибка: ${e instanceof Error ? e.message : e}` });
      });
  }, [remote, handleFiles]);

  const onInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      void handleFiles(e.target.files);
      e.target.value = "";
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      void handleFiles(e.dataTransfer.files);
    }
  };

  const onModelProgress = useCallback(
    (p: LoadProgress) => {
      setProgress(p);
      if (p.phase === "done") {
        setBusy(false);
        setTimeout(() => requestFit(), 400);
      }
    },
    [requestFit]
  );

  const clearScene = () => {
    revokeAll(locals);
    setLocals([]);
    setManifest(null);
    setGeo(null);
    setBusy(false);
    setProgress({ phase: "idle", percent: 0, message: "" });
    log.info("Сцена сброшена");
  };

  const hasScene = manifest !== null && locals.length > 0;
  const loading = busy || (progress.phase !== "idle" && progress.phase !== "done");

  return (
    <div className="viewer-root">
      {hasScene ? (
        <Scene
          locals={locals}
          manifest={manifest}
          showVPM={showVPM}
          showNPM={showNPM}
          showLights={showLights}
          sun={sun}
          fitTrigger={fitTrigger}
          fitPadding={fitPadding}
          onGeoLoaded={setGeo}
          onProgress={onModelProgress}
        />
      ) : remote ? (
        <div className="drop-zone" />
      ) : (
        <div
          className={`drop-zone ${dragOver ? "drag-over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <div className="drop-content">
            <h1>FBX Scene Viewer</h1>
            <p className="subtitle">
              Выбери корневую папку проекта — например
              <br />
              <code>2026-10-02_ВПМ_НПМ</code>
            </p>
            <div className="drop-actions">
              <button className="btn primary" onClick={() => folderInputRef.current?.click()}>
                Выбрать папку
              </button>
              <button className="btn" onClick={() => filesInputRef.current?.click()}>
                Выбрать файлы
              </button>
            </div>
            <p className="hint">
              Внутри: <b>Высокополигональная</b> (SM_*_001… + Ground, zip или папки)
              <br />и <b>Низкополигональная</b> (0102_* …)
            </p>
          </div>
        </div>
      )}

      <input
        ref={folderInputRef}
        type="file"
        // @ts-expect-error webkitdirectory
        webkitdirectory=""
        directory=""
        multiple
        style={{ display: "none" }}
        onChange={onInputChange}
      />
      <input
        ref={filesInputRef}
        type="file"
        multiple
        accept=".fbx,.png,.jpg,.jpeg,.geojson,.json,.tga,.webp,.zip"
        style={{ display: "none" }}
        onChange={onInputChange}
      />

      {(hasScene || loading) && (
        <>
          {hasScene && (
            <div className="top-bar">
              <div className="scene-name">
                {remote ? remote.name : "Локальная сцена"}
                <span className="file-count"> · {locals.length} файлов</span>
              </div>
              <div className="toggle-group">
                <button
                  className={showVPM ? "active" : ""}
                  onClick={() => setShowVPM((v) => !v)}
                  disabled={
                    (manifest?.vpmModels.length || 0) + (manifest?.groundModels.length || 0) === 0
                  }
                >
                  ВПМ
                </button>
                <button
                  className={showNPM ? "active" : ""}
                  onClick={() => setShowNPM((v) => !v)}
                  disabled={(manifest?.npmModels.length || 0) === 0}
                >
                  НПМ
                </button>
                <button
                  className={showLights ? "active" : ""}
                  onClick={() => setShowLights((v) => !v)}
                  disabled={(manifest?.lightFiles.length || 0) === 0}
                >
                  Свет
                </button>
                <button onClick={requestFit}>В кадр</button>
                <button onClick={() => setShowInfo((v) => !v)}>Инфо</button>
                <button className={showLog ? "active" : ""} onClick={() => setShowLog((v) => !v)}>
                  Лог
                </button>
                {remote && isAdmin && (
                  <button onClick={makePreview} disabled={previewState === "busy"} title="Снимок «В кадр» для карточки ссылки в мессенджерах">
                    {previewState === "busy" ? "Снимаю…" : previewState === "done" ? "Превью сохранено" : previewState === "error" ? "Ошибка превью" : "Сделать превью"}
                  </button>
                )}
                {!remote && <button onClick={() => folderInputRef.current?.click()}>+ Папка</button>}
                {!remote && <button onClick={clearScene}>Сброс</button>}
              </div>
            </div>
          )}

          {hasScene && (
            <div className="left-panel">
              <SunControls sun={sun} onChange={setSun} />
            </div>
          )}

          <InfoPanel geo={geo} visible={showInfo} onClose={() => setShowInfo(false)} />

          {showLog && logs.length > 0 && (
            <div className="log-panel">
              <div className="panel-header">
                <span className="panel-title">Отчёт</span>
                <button className="close-btn" onClick={() => setShowLog(false)}>
                  ×
                </button>
              </div>
              <div className="log-body">
                {logs.map((l, i) => (
                  <div key={i} className={`log-line log-${l.level}`}>
                    {l.message}
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            </div>
          )}

          {loading && (
            <div className="loading-overlay">
              <div className="progress-card">
                <div className="progress-meta">
                  <span>{progress.message || "Загрузка…"}</span>
                  <span className="progress-pct">{Math.round(progress.percent)}%</span>
                </div>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${Math.max(2, progress.percent)}%` }} />
                </div>
                {progress.detail && <p className="progress-detail">{progress.detail}</p>}
              </div>
            </div>
          )}

          {hasScene && !loading && (
            <div className="footer-hint">
              WASD — полёт · Q/E — вниз/вверх · Shift — быстрее · мышь с зажатой кнопкой — обзор · колесо — скорость
              {flySpeed !== null && <span className="fly-speed"> · {flySpeed < 10 ? flySpeed.toFixed(1) : Math.round(flySpeed)} м/с</span>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
