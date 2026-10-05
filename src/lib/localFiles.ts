import JSZip from "jszip";
import { SceneFileInfo, SceneManifest, GeoJsonData, LoadProgress } from "./types";
import { log, formatBytes } from "./logger";
import { clearTextureCache } from "./textureUtils";

export interface LocalFile {
  file: File;
  relativePath: string;
  objectUrl: string;
  info: SceneFileInfo;
}

export type ProgressFn = (p: LoadProgress) => void;

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function getRelativePath(file: File): string {
  const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  if (rel && rel.length > 0) return normalizePath(rel);
  return file.name;
}

function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i) : "";
}

function basename(path: string): string {
  return path.split("/").pop() || path;
}

const utf8Strict = new TextDecoder("utf-8", { fatal: true });

/** Имена в ZIP без флага UTF-8 (старые WinRAR/7-Zip) — CP866, иначе кириллица превращается в мусор. */
function decodeZipName(bytes: string[] | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes as unknown as number[]);
  try {
    return utf8Strict.decode(u8);
  } catch {
    try {
      return new TextDecoder("ibm866").decode(u8);
    } catch {
      return new TextDecoder("latin1").decode(u8);
    }
  }
}

function stripZipExt(name: string): string {
  return name.replace(/\.zip$/i, "");
}

function branchOfSegment(seg: string): "vpm" | "npm" | "unknown" {
  const s = seg.toLowerCase();
  const v =
    s.includes("высокополигон") || s.includes("впм") || s === "vpm" ||
    s.includes("highpoly") || s.includes("high-poly") || s.includes("high_poly");
  const n =
    s.includes("низкополигон") || s.includes("нпм") || s === "npm" ||
    s.includes("lowpoly") || s.includes("low-poly") || s.includes("low_poly");
  // «2026-10-02_ВПМ_НПМ» содержит оба слова — такой сегмент ничего не говорит
  if (v && !n) return "vpm";
  if (n && !v) return "npm";
  return "unknown";
}

/** ВПМ / НПМ по пути: побеждает ближайшая к файлу папка (кириллица тоже). */
export function detectBranch(path: string): "vpm" | "npm" | "unknown" {
  const segs = normalizePath(path).split("/");
  for (let i = segs.length - 1; i >= 0; i--) {
    const b = branchOfSegment(segs[i]);
    if (b !== "unknown") return b;
  }
  return "unknown";
}

function isNpmName(name: string, path: string): boolean {
  const branch = detectBranch(path);
  if (branch === "npm") return true;
  if (branch === "vpm") return false;
  return (
    /^0000_/.test(name) ||
    /^\d{4}_/.test(name) ||
    /\/\d{4}_/.test(path.toLowerCase())
  );
}

export function classifyLocal(relativePath: string): SceneFileInfo {
  const name = basename(relativePath);
  const lower = name.toLowerCase();
  const branch = detectBranch(relativePath);

  if (lower.endsWith(".zip")) {
    return { path: relativePath, name, type: "zip", branch };
  }

  if (lower.endsWith(".geojson") || (lower.endsWith(".json") && !lower.includes("package"))) {
    return { path: relativePath, name, type: "geojson", branch };
  }

  if (lower.includes("_light") && lower.endsWith(".fbx")) {
    return { path: relativePath, name, type: "light", branch, baseName: name.replace(/\.fbx$/i, "") };
  }

  if (/\.(png|jpg|jpeg|tga|webp)$/i.test(lower)) {
    return { path: relativePath, name, type: "texture", branch };
  }

  if (lower.endsWith(".fbx")) {
    const npm = isNpmName(name, relativePath);
    const baseName = name.replace(/\.fbx$/i, "");

    if (lower.includes("ground")) {
      if (npm) {
        return { path: relativePath, name, type: "npm", baseName, branch: "npm" };
      }
      return { path: relativePath, name, type: "ground", baseName, branch: "vpm" };
    }

    if (npm) {
      return { path: relativePath, name, type: "npm", baseName, branch: "npm" };
    }

    return { path: relativePath, name, type: "vpm", baseName, branch: branch === "unknown" ? "vpm" : branch };
  }

  return { path: relativePath, name, type: "other", branch };
}

function skipPath(path: string): boolean {
  const n = basename(path);
  if (n.startsWith(".") || n === "Thumbs.db" || n === "desktop.ini") return true;
  if (path.includes("__MACOSX") || path.includes("node_modules") || path.includes(".git/")) return true;
  return false;
}

function mimeForName(name: string): string {
  const l = name.toLowerCase();
  if (l.endsWith(".fbx")) return "application/octet-stream";
  if (l.endsWith(".png")) return "image/png";
  if (l.endsWith(".jpg") || l.endsWith(".jpeg")) return "image/jpeg";
  if (l.endsWith(".webp")) return "image/webp";
  if (l.endsWith(".json") || l.endsWith(".geojson")) return "application/json";
  return "application/octet-stream";
}

async function unzipOne(
  zipFile: File,
  zipRelPath: string,
  onInner?: (done: number, total: number) => void
): Promise<{ file: File; relativePath: string }[]> {
  log.info(`Распаковка ZIP: ${zipRelPath} (${formatBytes(zipFile.size)})`);
  const buf = await zipFile.arrayBuffer();
  const zip = await JSZip.loadAsync(buf, { decodeFileName: decodeZipName });
  const entries = Object.values(zip.files).filter((e) => !e.dir && !skipPath(e.name));
  const zipStem = stripZipExt(basename(zipRelPath));
  const zipParent = parentDir(zipRelPath);
  const prefix = zipParent ? `${zipParent}/${zipStem}` : zipStem;

  const out: { file: File; relativePath: string }[] = [];
  let i = 0;
  for (const entry of entries) {
    i++;
    onInner?.(i, entries.length);
    const blob = await entry.async("blob");
    const name = basename(entry.name);
    const file = new File([blob], name, { type: mimeForName(name) });
    const inner = normalizePath(entry.name);
    const relativePath = `${prefix}/${inner}`;
    out.push({ file, relativePath });
  }
  log.ok(`ZIP готов: ${zipRelPath} → ${out.length} файлов`);
  return out;
}

export async function ingestFiles(
  fileList: FileList | File[],
  onProgress: ProgressFn
): Promise<{ locals: LocalFile[]; manifest: SceneManifest }> {
  const raw = Array.from(fileList);
  log.group("Загрузка папки");
  log.info(`Выбрано элементов: ${raw.length}`);

  onProgress({ phase: "scan", percent: 2, message: "Сканирование файлов…" });

  const loose: { file: File; relativePath: string }[] = [];
  const zips: { file: File; relativePath: string }[] = [];

  for (const file of raw) {
    const relativePath = getRelativePath(file);
    if (skipPath(relativePath)) continue;
    if (file.name.toLowerCase().endsWith(".zip")) {
      zips.push({ file, relativePath });
    } else {
      loose.push({ file, relativePath });
    }
  }

  log.info(`Обычных файлов: ${loose.length}, архивов ZIP: ${zips.length}`);
  zips.forEach((z) => log.info(`  ZIP  ${z.relativePath}  ${formatBytes(z.file.size)}`));

  const expanded: { file: File; relativePath: string }[] = [...loose];

  if (zips.length) {
    for (let zi = 0; zi < zips.length; zi++) {
      const z = zips[zi];
      const base = 8 + Math.round((zi / zips.length) * 32);
      onProgress({
        phase: "unzip",
        percent: base,
        message: `Распаковка архива ${zi + 1}/${zips.length}`,
        detail: z.relativePath,
      });
      try {
        const inner = await unzipOne(z.file, z.relativePath, (done, total) => {
          const innerPct = total ? done / total : 1;
          const pct = 8 + Math.round(((zi + innerPct) / zips.length) * 32);
          onProgress({
            phase: "unzip",
            percent: Math.min(40, pct),
            message: `Распаковка ${zi + 1}/${zips.length}: ${done}/${total}`,
            detail: z.relativePath,
          });
        });
        expanded.push(...inner);
      } catch (e) {
        log.error(`Не удалось распаковать ${z.relativePath}`, e);
      }
    }
  }

  onProgress({ phase: "classify", percent: 42, message: "Классификация файлов…" });

  const locals: LocalFile[] = [];
  const skipped: string[] = [];

  for (const item of expanded) {
    const info = classifyLocal(item.relativePath);
    if (info.type === "other" || info.type === "zip") {
      skipped.push(item.relativePath);
      continue;
    }
    const objectUrl = URL.createObjectURL(item.file);
    locals.push({
      file: item.file,
      relativePath: item.relativePath,
      objectUrl,
      info: { ...info, path: item.relativePath },
    });
  }

  const infos = locals.map((l) => l.info);
  const manifest: SceneManifest = {
    sceneId: "local",
    files: infos,
    vpmModels: infos.filter((f) => f.type === "vpm"),
    npmModels: infos.filter((f) => f.type === "npm"),
    groundModels: infos.filter((f) => f.type === "ground"),
    lightFiles: infos.filter((f) => f.type === "light"),
    geojsonFiles: infos.filter((f) => f.type === "geojson"),
  };

  const texCount = infos.filter((f) => f.type === "texture").length;
  log.info("Итог классификации:", {
    ВПМ: manifest.vpmModels.map((m) => m.name),
    НПМ: manifest.npmModels.map((m) => m.name),
    Ground: manifest.groundModels.map((m) => m.name),
    Light: manifest.lightFiles.map((m) => m.name),
    geojson: manifest.geojsonFiles.map((m) => m.name),
    текстуры: texCount,
  });
  log.ok(
    `ВПМ ${manifest.vpmModels.length} · Ground ${manifest.groundModels.length} · НПМ ${manifest.npmModels.length} · свет ${manifest.lightFiles.length} · geojson ${manifest.geojsonFiles.length} · текстуры ${texCount}`
  );

  if (manifest.vpmModels.length === 0 && manifest.npmModels.length === 0) {
    log.warn("FBX моделей не найдено. Проверь, что выбрана корневая папка проекта (с «Высокополигональная» / «Низкополигональная»).");
  }

  log.groupEnd();

  onProgress({
    phase: "classify",
    percent: 45,
    message: "Файлы разобраны",
    detail: `ВПМ ${manifest.vpmModels.length} · НПМ ${manifest.npmModels.length}`,
  });

  return { locals, manifest };
}

export function revokeAll(locals: LocalFile[]) {
  locals.forEach((l) => URL.revokeObjectURL(l.objectUrl));
  clearTextureCache();
}

export async function readGeoJsonFromFile(file: File): Promise<GeoJsonData | null> {
  try {
    const text = await file.text();
    return JSON.parse(text) as GeoJsonData;
  } catch (e) {
    log.warn("geojson не прочитан", e);
    return null;
  }
}

export function buildUrlMap(locals: LocalFile[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const l of locals) {
    map.set(l.relativePath, l.objectUrl);
    map.set(l.info.name, l.objectUrl);
  }
  return map;
}
