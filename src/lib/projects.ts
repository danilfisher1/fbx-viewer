import { createServerFn } from "@tanstack/react-start";

/**
 * Проекты для архитекторов: ссылка /p/<slug> открывает модель с Яндекс Диска без ручной загрузки.
 * Админка защищена одним паролем из переменной окружения ADMIN_PASSWORD (Vercel → Settings →
 * Environment Variables). Сессия — httpOnly-cookie с HMAC от пароля: смена пароля разлогинивает всех.
 *
 * Список проектов — один JSON в приватном хранилище Vercel Blob (fbx-viewer-blob, токен
 * BLOB_READ_WRITE_TOKEN Vercel добавляет сам). Без токена (локальная разработка) — в памяти процесса.
 */

export interface Project {
  id: number;
  slug: string;
  name: string;
  yandex_url: string;
  created_at: string;
  /** Версия картинки-превью для ссылок (меняется при пересъёмке — сбрасывает кэш мессенджеров). */
  preview_v?: number;
}

export interface PublicProject {
  name: string;
  yandexUrl: string;
  slug: string;
  /** Абсолютный адрес сайта — для og:image / og:url. */
  origin: string;
  previewVersion?: number;
}

export const previewBlobPath = (slug: string) => `previews/${slug}.jpg`;

const COOKIE = "fbx_admin";
const PROJECTS_PATH = "projects.json";

const memory = globalThis as typeof globalThis & { __fbxProjects__?: Project[] };

async function readProjects(): Promise<Project[]> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return memory.__fbxProjects__ ?? [];
  const { get } = await import("@vercel/blob");
  const res = await get(PROJECTS_PATH, { access: "private", useCache: false });
  if (!res) return [];
  const text = await new Response(res.stream).text();
  return JSON.parse(text) as Project[];
}

async function writeProjects(list: Project[]): Promise<void> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    memory.__fbxProjects__ = list;
    return;
  }
  const { put } = await import("@vercel/blob");
  await put(PROJECTS_PATH, JSON.stringify(list), {
    access: "private",
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: "application/json",
  });
}

async function sessionToken(): Promise<string | null> {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return null;
  const { createHmac } = await import("node:crypto");
  return createHmac("sha256", password).update("fbx-viewer-admin").digest("hex");
}

async function isAdmin(): Promise<boolean> {
  const { getCookie } = await import("@tanstack/react-start/server");
  const expected = await sessionToken();
  const got = getCookie(COOKIE);
  if (!expected || !got || got.length !== expected.length) return false;
  const { timingSafeEqual } = await import("node:crypto");
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

async function requireAdmin() {
  if (!(await isAdmin())) throw new Error("Нужен вход в админку");
}

/** Только публичные ссылки Яндекс Диска (disk.yandex.ru/d/…, yadi.sk/…) — других адресов не принимаем. */
function normalizeYandexUrl(raw: string): string {
  const url = new URL(raw.trim());
  const host = url.hostname.replace(/^www\./, "");
  const ok = /^(disk\.yandex\.(ru|com|by|kz|uz)|disk\.360\.yandex\.(ru|com)|yadi\.sk)$/.test(host);
  const pathOk = host === "yadi.sk" || /^\/(d|i|public)\//.test(url.pathname);
  if (url.protocol !== "https:" || !ok || !pathOk) {
    throw new Error("Нужна публичная ссылка Яндекс Диска вида https://disk.yandex.ru/d/…");
  }
  return url.toString();
}

export const getAdminState = createServerFn({ method: "GET" }).handler(async () => ({
  configured: !!process.env.ADMIN_PASSWORD,
  loggedIn: await isAdmin(),
}));

export const adminLogin = createServerFn({ method: "POST" })
  .inputValidator((d: { password: string }) => d)
  .handler(async ({ data }) => {
    const password = process.env.ADMIN_PASSWORD;
    if (!password) throw new Error("ADMIN_PASSWORD не задан в настройках Vercel");
    const { timingSafeEqual, createHash } = await import("node:crypto");
    const a = createHash("sha256").update(String(data.password ?? "")).digest();
    const b = createHash("sha256").update(password).digest();
    if (!timingSafeEqual(a, b)) throw new Error("Неверный пароль");
    const { setCookie } = await import("@tanstack/react-start/server");
    setCookie(COOKIE, (await sessionToken())!, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return { ok: true };
  });

export const adminLogout = createServerFn({ method: "POST" }).handler(async () => {
  const { deleteCookie } = await import("@tanstack/react-start/server");
  deleteCookie(COOKIE, { path: "/" });
  return { ok: true };
});

export const listProjects = createServerFn({ method: "GET" }).handler(async (): Promise<Project[]> => {
  await requireAdmin();
  const list = await readProjects();
  return list.sort((a, b) => b.created_at.localeCompare(a.created_at));
});

export const createProject = createServerFn({ method: "POST" })
  .inputValidator((d: { name: string; yandexUrl: string }) => d)
  .handler(async ({ data }): Promise<Project> => {
    await requireAdmin();
    const name = String(data.name ?? "").trim().slice(0, 200);
    if (!name) throw new Error("Укажите название проекта");
    const yandexUrl = normalizeYandexUrl(String(data.yandexUrl ?? ""));
    const { randomBytes } = await import("node:crypto");
    // Случайный slug: ссылки нельзя подобрать перебором.
    const slug = randomBytes(6).toString("base64url");
    const list = await readProjects();
    const project: Project = {
      id: list.reduce((m, p) => Math.max(m, p.id), 0) + 1,
      slug,
      name,
      yandex_url: yandexUrl,
      created_at: new Date().toISOString(),
    };
    await writeProjects([...list, project]);
    return project;
  });

export const updateProject = createServerFn({ method: "POST" })
  .inputValidator((d: { id: number; name: string; yandexUrl: string }) => d)
  .handler(async ({ data }) => {
    await requireAdmin();
    const name = String(data.name ?? "").trim().slice(0, 200);
    if (!name) throw new Error("Укажите название проекта");
    const yandexUrl = normalizeYandexUrl(String(data.yandexUrl ?? ""));
    const list = await readProjects();
    const p = list.find((x) => x.id === Number(data.id));
    if (!p) throw new Error("Проект не найден");
    p.name = name;
    p.yandex_url = yandexUrl;
    await writeProjects(list);
    return { ok: true };
  });

export const deleteProject = createServerFn({ method: "POST" })
  .inputValidator((d: { id: number }) => d)
  .handler(async ({ data }) => {
    await requireAdmin();
    const list = await readProjects();
    await writeProjects(list.filter((x) => x.id !== Number(data.id)));
    return { ok: true };
  });

/** Публично: по slug — только название и ссылка на Диск. */
export const getProjectBySlug = createServerFn({ method: "GET" })
  .inputValidator((d: { slug: string }) => d)
  .handler(async ({ data }): Promise<PublicProject | null> => {
    const p = (await readProjects()).find((x) => x.slug === String(data.slug ?? ""));
    if (!p) return null;
    const { getRequestUrl } = await import("@tanstack/react-start/server");
    return {
      name: p.name,
      yandexUrl: p.yandex_url,
      slug: p.slug,
      origin: getRequestUrl({ xForwardedHost: true, xForwardedProto: true }).origin,
      previewVersion: p.preview_v,
    };
  });

/** Админ: можно ли показывать кнопку «Сделать превью» на странице проекта. */
export const canEditPreview = createServerFn({ method: "GET" }).handler(async () => isAdmin());

/** Админ: сохранить снимок модели (JPEG 1200×630, data URL) как превью ссылки. */
export const savePreview = createServerFn({ method: "POST" })
  .inputValidator((d: { slug: string; dataUrl: string }) => d)
  .handler(async ({ data }) => {
    await requireAdmin();
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(data.dataUrl ?? ""));
    if (!m) throw new Error("Ожидался JPEG");
    const bytes = Buffer.from(m[1], "base64");
    if (bytes.length > 3_000_000) throw new Error("Превью слишком большое");
    const list = await readProjects();
    const p = list.find((x) => x.slug === String(data.slug ?? ""));
    if (!p) throw new Error("Проект не найден");
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      const { put } = await import("@vercel/blob");
      await put(previewBlobPath(p.slug), bytes, {
        access: "private",
        allowOverwrite: true,
        addRandomSuffix: false,
        contentType: "image/jpeg",
      });
    } else {
      previewMemory.set(p.slug, bytes);
    }
    p.preview_v = Date.now();
    await writeProjects(list);
    return { ok: true, version: p.preview_v };
  });

const previewMemory = ((globalThis as typeof globalThis & { __fbxPreviews__?: Map<string, Buffer> }).__fbxPreviews__ ??=
  new Map<string, Buffer>());

/** Для серверного маршрута /preview/<slug>: байты картинки или null. */
export async function readPreview(slug: string): Promise<Uint8Array | null> {
  if (!/^[A-Za-z0-9_-]{4,32}$/.test(slug)) return null;
  if (!process.env.BLOB_READ_WRITE_TOKEN) return previewMemory.get(slug) ?? null;
  const { get } = await import("@vercel/blob");
  const res = await get(previewBlobPath(slug), { access: "private", useCache: false });
  if (!res) return null;
  return new Uint8Array(await new Response(res.stream).arrayBuffer());
}
