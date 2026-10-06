import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  adminLogin,
  adminLogout,
  createProject,
  deleteProject,
  getAdminState,
  listProjects,
  updateProject,
  type Project,
} from "@/lib/projects";

export const Route = createFileRoute("/admin")({ component: AdminPage });

function errText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

function AdminPage() {
  const [state, setState] = useState<{ configured: boolean; loggedIn: boolean } | null>(null);

  const refresh = useCallback(() => {
    getAdminState().then(setState).catch(() => setState({ configured: false, loggedIn: false }));
  }, []);
  useEffect(refresh, [refresh]);

  return (
    <div className="admin-root">
      <div className="admin-wrap">
        <header className="admin-head">
          <h1>Проекты</h1>
          {state?.loggedIn && (
            <button className="btn small" onClick={() => adminLogout().then(refresh)}>
              Выйти
            </button>
          )}
        </header>
        {!state ? (
          <p className="muted">Загрузка…</p>
        ) : !state.configured ? (
          <div className="admin-card">
            <p>
              Админка не настроена: в Vercel → Settings → Environment Variables добавьте <code>ADMIN_PASSWORD</code> и
              перезапустите деплой.
            </p>
          </div>
        ) : state.loggedIn ? (
          <ProjectsAdmin />
        ) : (
          <LoginForm onDone={refresh} />
        )}
      </div>
    </div>
  );
}

function LoginForm({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await adminLogin({ data: { password } });
      onDone();
    } catch (err) {
      setError(errText(err));
    }
  };
  return (
    <form className="admin-card admin-form" onSubmit={submit}>
      <label>
        Пароль администратора
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
      </label>
      {error && <p className="admin-error">{error}</p>}
      <button className="btn primary" type="submit">
        Войти
      </button>
    </form>
  );
}

/**
 * Ссылка для отправки. С версией превью в адресе: мессенджеры кэшируют карточку по URL,
 * и после пересъёмки превью новая ссылка сразу покажет свежую картинку.
 */
function shareUrl(p: Project) {
  const base = `${window.location.origin}/p/${p.slug}`;
  return p.preview_v ? `${base}?v=${p.preview_v.toString(36)}` : base;
}

function ProjectsAdmin() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [yandexUrl, setYandexUrl] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [editing, setEditing] = useState<Project | null>(null);

  const load = useCallback(() => {
    listProjects()
      .then(setProjects)
      .catch((e) => setError(errText(e)));
  }, []);
  useEffect(load, [load]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await createProject({ data: { name, yandexUrl } });
      setName("");
      setYandexUrl("");
      load();
    } catch (err) {
      setError(errText(err));
    }
  };

  const copy = async (p: Project) => {
    await navigator.clipboard.writeText(shareUrl(p));
    setCopied(p.slug);
    setTimeout(() => setCopied(null), 1500);
  };

  const remove = async (p: Project) => {
    if (!confirm(`Удалить проект «${p.name}»? Ссылка перестанет работать (файлы на Яндекс Диске останутся).`)) return;
    try {
      await deleteProject({ data: { id: p.id } });
      load();
    } catch (err) {
      setError(errText(err));
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    try {
      await updateProject({ data: { id: editing.id, name: editing.name, yandexUrl: editing.yandex_url } });
      setEditing(null);
      load();
    } catch (err) {
      setError(errText(err));
    }
  };

  return (
    <>
      <form className="admin-card admin-form" onSubmit={add}>
        <h2>Новый проект</h2>
        <label>
          Название
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="ЖК Елизаветинский, 02.10.2026" />
        </label>
        <label>
          Публичная ссылка Яндекс Диска на папку проекта или архив
          <input
            value={yandexUrl}
            onChange={(e) => setYandexUrl(e.target.value)}
            placeholder="https://disk.yandex.ru/d/…"
          />
        </label>
        <p className="muted small">
          В папке — как обычно: «Высокополигональная» и «Низкополигональная» с ZIP или папками. На Диске: правый клик
          по папке → «Поделиться» → «Скопировать ссылку».
        </p>
        {error && <p className="admin-error">{error}</p>}
        <button className="btn primary" type="submit">
          Создать ссылку
        </button>
      </form>

      <div className="admin-card">
        {!projects ? (
          <p className="muted">Загрузка…</p>
        ) : projects.length === 0 ? (
          <p className="muted">Проектов пока нет.</p>
        ) : (
          <ul className="admin-list">
            {projects.map((p) =>
              editing?.id === p.id ? (
                <li key={p.id}>
                  <form className="admin-form" onSubmit={save}>
                    <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                    <input
                      value={editing.yandex_url}
                      onChange={(e) => setEditing({ ...editing, yandex_url: e.target.value })}
                    />
                    <div className="admin-actions">
                      <button className="btn small primary" type="submit">
                        Сохранить
                      </button>
                      <button className="btn small" type="button" onClick={() => setEditing(null)}>
                        Отмена
                      </button>
                    </div>
                  </form>
                </li>
              ) : (
                <li key={p.id}>
                  <div className="admin-item-main">
                    <b>{p.name}</b>
                    <a href={`/p/${p.slug}`} target="_blank" rel="noreferrer">
                      {`/p/${p.slug}`}
                    </a>
                    <span className="muted small">{p.yandex_url}</span>
                    <span className="muted small">{p.preview_v ? "Превью есть" : "Превью нет — откройте проект и нажмите «Сделать превью»"}</span>
                  </div>
                  <div className="admin-actions">
                    <button className="btn small primary" onClick={() => copy(p)}>
                      {copied === p.slug ? "Скопировано" : "Копировать ссылку"}
                    </button>
                    <button className="btn small" onClick={() => setEditing(p)}>
                      Изменить
                    </button>
                    <button className="btn small danger" onClick={() => remove(p)}>
                      Удалить
                    </button>
                  </div>
                </li>
              )
            )}
          </ul>
        )}
      </div>
    </>
  );
}
