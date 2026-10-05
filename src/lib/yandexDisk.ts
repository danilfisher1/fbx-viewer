import { log, formatBytes } from "./logger";

/**
 * Загрузка проекта по публичной ссылке Яндекс Диска прямо в браузер (REST API Диска и
 * сервер скачивания отдают CORS). Ссылка может вести на папку (обходится рекурсивно,
 * структура Высокополигональная/Низкополигональная сохраняется) или на один архив.
 * Файлы превращаются в File с webkitRelativePath — дальше работает обычный ingestFiles.
 *
 * Кэш: скачанные файлы сохраняются в Cache Storage браузера (переживает перезагрузку,
 * вмещает гигабайты). При повторном открытии сверяем md5 из списка Диска — неизменённые
 * файлы берутся с компьютера, изменённые перекачиваются. Нет сети — открываем из кэша.
 */

const API = "https://cloud-api.yandex.net/v1/disk/public/resources";
/**
 * Яндекс защищает скачивание от хотлинка: с Referer чужого сайта downloader.disk.yandex.ru
 * отвечает 403 без CORS-заголовков (браузер пишет «Failed to fetch»), с localhost — пропускает.
 * Без Referer скачивание разрешено с любого адреса.
 */
const NO_REFERRER: RequestInit = { referrerPolicy: "no-referrer" };
const PAGE = 1000;

const CACHE_NAME = "fbx-viewer-projects-v1";
const cachePrefix = (publicKey: string) => `https://fbx-cache.local/${encodeURIComponent(publicKey)}/`;
const cacheKey = (publicKey: string, path: string, md5 = "") =>
  `${cachePrefix(publicKey)}${encodeURIComponent(path)}?md5=${md5}`;
const manifestKey = (publicKey: string) => `${cachePrefix(publicKey)}__manifest.json`;

async function openCache(): Promise<Cache | null> {
  try {
    if (typeof caches === "undefined") return null;
    // Просим браузер не вытеснять кэш при нехватке места (если нельзя — молча игнорируется).
    navigator.storage?.persist?.().catch(() => {});
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

interface Resource {
  type: "dir" | "file";
  name: string;
  path: string;
  size?: number;
  file?: string;
  md5?: string;
  _embedded?: { items: Resource[]; total: number };
}

async function api<T>(url: string): Promise<T> {
  const res = await fetch(url, NO_REFERRER);
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const j = await res.json();
      msg = j.description || j.message || msg;
    } catch {
      /* ignore */
    }
    throw new Error(`Яндекс Диск: ${msg}`);
  }
  return res.json() as Promise<T>;
}

function resourceUrl(publicKey: string, path: string, offset = 0) {
  const q = new URLSearchParams({ public_key: publicKey, path, limit: String(PAGE), offset: String(offset) });
  return `${API}?${q}`;
}

async function listAll(publicKey: string): Promise<{ root: string; files: Resource[] }> {
  const files: Resource[] = [];
  const top = await api<Resource>(resourceUrl(publicKey, "/"));
  if (top.type === "file") return { root: "", files: [{ ...top, path: "/" + top.name }] };

  const walk = async (path: string) => {
    let offset = 0;
    for (;;) {
      const r = path === "/" && offset === 0 ? top : await api<Resource>(resourceUrl(publicKey, path, offset));
      const items = r._embedded?.items ?? [];
      for (const it of items) {
        if (it.type === "dir") await walk(it.path);
        else files.push(it);
      }
      offset += items.length;
      if (!items.length || offset >= (r._embedded?.total ?? 0)) break;
    }
  };
  await walk("/");
  return { root: top.name, files };
}

async function downloadHref(publicKey: string, item: Resource): Promise<string> {
  if (item.file) return item.file;
  const q = new URLSearchParams({ public_key: publicKey, path: item.path });
  const r = await api<{ href: string }>(`${API}/download?${q}`);
  return r.href;
}

/** Скачивание с прогрессом по байтам (чтение потока). */
async function fetchWithProgress(url: string, onBytes: (n: number) => void): Promise<Blob> {
  const res = await fetch(url, NO_REFERRER);
  if (!res.ok || !res.body) throw new Error(`Скачивание не удалось (${res.status})`);
  const reader = res.body.getReader();
  const chunks: BlobPart[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as BlobPart);
    onBytes(value.byteLength);
  }
  return new Blob(chunks);
}

export interface DownloadProgress {
  loaded: number;
  total: number;
  file: string;
}

export async function downloadYandexProject(
  publicUrl: string,
  onProgress: (p: DownloadProgress) => void
): Promise<File[]> {
  const cache = await openCache();
  log.info(`Яндекс Диск: читаю список файлов`);
  let listing: { root: string; files: Resource[] };
  try {
    listing = await listAll(publicUrl);
    await cache?.put(manifestKey(publicUrl), new Response(JSON.stringify(listing))).catch(() => {});
  } catch (e) {
    const cached = await cache?.match(manifestKey(publicUrl));
    if (!cached) throw e;
    log.warn("Яндекс Диск недоступен — открываю сохранённую копию", e);
    listing = (await cached.json()) as typeof listing;
  }
  const { root, files } = listing;
  if (!files.length) throw new Error("По ссылке нет файлов");
  const total = files.reduce((n, f) => n + (f.size ?? 0), 0);
  log.info(`Яндекс Диск: файлов ${files.length}, ${formatBytes(total)}`);

  let loaded = 0;
  let fromCache = 0;
  const out: File[] = [];
  for (const item of files) {
    const rel = item.path.replace(/^\/+/, "");
    onProgress({ loaded, total, file: rel });
    const key = cacheKey(publicUrl, item.path, item.md5);
    let blob: Blob | null = null;
    const hit = await cache?.match(key);
    if (hit) {
      blob = await hit.blob();
      if (item.size && blob.size !== item.size) blob = null; // недокачанная или битая копия
    }
    const cached = !!blob;
    if (blob) {
      fromCache += blob.size;
      loaded += blob.size;
    } else {
      const href = await downloadHref(publicUrl, item);
      blob = await fetchWithProgress(href, (n) => {
        loaded += n;
        onProgress({ loaded, total, file: rel });
      });
      try {
        await cache?.put(key, new Response(blob));
      } catch (e) {
        log.warn(`Не хватило места для кэша: ${rel}`, e);
      }
    }
    const file = new File([blob], item.name);
    Object.defineProperty(file, "webkitRelativePath", { value: root ? `${root}/${rel}` : rel });
    out.push(file);
    log.ok(`${cached ? "С компьютера (кэш)" : "Скачан"}: ${rel} (${formatBytes(blob.size)})`);
  }
  if (fromCache) log.info(`Взято из кэша: ${formatBytes(fromCache)} из ${formatBytes(total)} — с Диска не качали`);
  await pruneProjectCache(cache, publicUrl, files);
  return out;
}

/** Убираем из кэша старые версии файлов проекта (md5 изменился или файл удалён с Диска). */
async function pruneProjectCache(cache: Cache | null, publicKey: string, files: Resource[]) {
  if (!cache) return;
  const keep = new Set(files.map((f) => cacheKey(publicKey, f.path, f.md5)));
  keep.add(manifestKey(publicKey));
  const prefix = cachePrefix(publicKey);
  for (const req of await cache.keys()) {
    if (req.url.startsWith(prefix) && !keep.has(req.url)) await cache.delete(req);
  }
}
