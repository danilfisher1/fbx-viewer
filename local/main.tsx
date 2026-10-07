/**
 * Вход exe-версии: статическая страница, которую раздаёт launcher (3D-просмотр.exe) с 127.0.0.1.
 * Launcher отдаёт /__local/info (имя проекта + список файлов из папок рядом с exe)
 * и /__local/file?path=… (сами файлы). Нашлись модели — проект открывается сам;
 * нет — обычный стартовый экран с выбором папки.
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import ViewerUI, { type ProjectSource } from "@/components/ViewerUI";
import "@/styles.css";

interface LocalInfo {
  name: string;
  files: { path: string; size: number }[];
}

async function readLocalFiles(
  info: LocalInfo,
  onProgress: (p: { loaded: number; total: number; file: string }) => void
): Promise<File[]> {
  const total = info.files.reduce((n, f) => n + f.size, 0);
  let loaded = 0;
  const out: File[] = [];
  for (const f of info.files) {
    onProgress({ loaded, total, file: f.path });
    const res = await fetch(`/__local/file?path=${encodeURIComponent(f.path)}`);
    if (!res.ok) throw new Error(`Не удалось прочитать ${f.path} (${res.status})`);
    const blob = await res.blob();
    loaded += blob.size;
    const file = new File([blob], f.path.split("/").pop() ?? f.path);
    Object.defineProperty(file, "webkitRelativePath", { value: `${info.name}/${f.path}` });
    out.push(file);
  }
  onProgress({ loaded, total, file: "" });
  return out;
}

function App() {
  const [state, setState] = useState<{ source: ProjectSource | null } | null>(null);

  useEffect(() => {
    fetch("/__local/info")
      .then((r) => (r.ok ? (r.json() as Promise<LocalInfo>) : null))
      .catch(() => null)
      .then((info) => {
        if (!info || !info.files.length) return setState({ source: null });
        document.title = `${info.name} — 3D`;
        setState({
          source: { name: info.name, verb: "Чтение", load: (onProgress) => readLocalFiles(info, onProgress) },
        });
      });
  }, []);

  if (!state) return null;
  // Моделей рядом с программой нет — стартовый экран с выбором папки проекта.
  return state.source ? <ViewerUI remote={state.source} /> : <ViewerUI />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
