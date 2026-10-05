import { createServerFn } from "@tanstack/react-start";

/**
 * Проекты для архитекторов: ссылка /p/<slug> открывает модель с Яндекс Диска без ручной загрузки.
 * Админка защищена одним паролем из переменной окружения ADMIN_PASSWORD (Vercel → Settings →
 * Environment Variables). Сессия — httpOnly-cookie с HMAC от пароля: смена пароля разлогинивает всех.
 */

export interface Project {
  id: number;
  slug: string;
  name: string;
  yandex_url: string;
  created_at: string;
}

export interface PublicProject {
  name: string;
  yandexUrl: string;
}

const COOKIE = "fbx_admin";

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
  const { getSql } = await import("./db");
  const sql = await getSql();
  return sql<Project>`select id, slug, name, yandex_url, created_at::text as created_at from projects order by created_at desc`;
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
    const { getSql } = await import("./db");
    const sql = await getSql();
    const rows = await sql<Project>`
      insert into projects (slug, name, yandex_url) values (${slug}, ${name}, ${yandexUrl})
      returning id, slug, name, yandex_url, created_at::text as created_at`;
    return rows[0];
  });

export const updateProject = createServerFn({ method: "POST" })
  .inputValidator((d: { id: number; name: string; yandexUrl: string }) => d)
  .handler(async ({ data }) => {
    await requireAdmin();
    const name = String(data.name ?? "").trim().slice(0, 200);
    if (!name) throw new Error("Укажите название проекта");
    const yandexUrl = normalizeYandexUrl(String(data.yandexUrl ?? ""));
    const { getSql } = await import("./db");
    const sql = await getSql();
    await sql`update projects set name = ${name}, yandex_url = ${yandexUrl} where id = ${Number(data.id)}`;
    return { ok: true };
  });

export const deleteProject = createServerFn({ method: "POST" })
  .inputValidator((d: { id: number }) => d)
  .handler(async ({ data }) => {
    await requireAdmin();
    const { getSql } = await import("./db");
    const sql = await getSql();
    await sql`delete from projects where id = ${Number(data.id)}`;
    return { ok: true };
  });

/** Публично: по slug — только название и ссылка на Диск. */
export const getProjectBySlug = createServerFn({ method: "GET" })
  .inputValidator((d: { slug: string }) => d)
  .handler(async ({ data }): Promise<PublicProject | null> => {
    const { getSql } = await import("./db");
    const sql = await getSql();
    const rows = await sql<{ name: string; yandex_url: string }>`
      select name, yandex_url from projects where slug = ${String(data.slug ?? "")} limit 1`;
    return rows[0] ? { name: rows[0].name, yandexUrl: rows[0].yandex_url } : null;
  });
