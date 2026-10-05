export type LogLevel = "info" | "warn" | "error" | "ok";

export interface LogEntry {
  t: number;
  level: LogLevel;
  message: string;
}

const PREFIX = "[FBX Viewer]";

type Listener = (entry: LogEntry) => void;
const listeners = new Set<Listener>();

export function subscribeLogs(fn: Listener) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emit(level: LogLevel, message: string, extra?: unknown) {
  const entry: LogEntry = { t: Date.now(), level, message };
  if (level === "error") {
    if (extra !== undefined) console.error(PREFIX, message, extra);
    else console.error(PREFIX, message);
  } else if (level === "warn") {
    if (extra !== undefined) console.warn(PREFIX, message, extra);
    else console.warn(PREFIX, message);
  } else {
    if (extra !== undefined) console.log(PREFIX, message, extra);
    else console.log(PREFIX, message);
  }
  listeners.forEach((fn) => fn(entry));
}

export const log = {
  info: (msg: string, extra?: unknown) => emit("info", msg, extra),
  ok: (msg: string, extra?: unknown) => emit("ok", msg, extra),
  warn: (msg: string, extra?: unknown) => emit("warn", msg, extra),
  error: (msg: string, extra?: unknown) => emit("error", msg, extra),
  group: (title: string) => {
    console.group(`${PREFIX} ${title}`);
  },
  groupEnd: () => console.groupEnd(),
};

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} МБ`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} ГБ`;
}
