#!/usr/bin/env node
/**
 * Сборка 3D-просмотр.exe (Windows, ничего устанавливать не нужно):
 *   1. статический вьювер (vite.local.config.ts) -> dist-local/
 *   2. + HDRI окружения из public/hdri
 *   3. всё это -> launcher/site.zip (вшивается в exe как ресурс)
 *   4. dotnet publish (self-contained, single-file) -> release/3D-просмотр.exe
 * Нужен .NET SDK 10+.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { join, relative } from "node:path";
import JSZip from "jszip";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const dist = join(root, "dist-local");
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });

console.log("[build:exe] вьювер…");
run("node", ["node_modules/vite/bin/vite.js", "build", "-c", "vite.local.config.ts"]);
cpSync(join(root, "public", "hdri"), join(dist, "hdri"), { recursive: true });

console.log("[build:exe] site.zip…");
const zip = new JSZip();
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else zip.file(relative(dist, p).replace(/\\/g, "/"), readFileSync(p));
  }
};
walk(dist);
writeFileSync(join(root, "launcher", "site.zip"), await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));

console.log("[build:exe] dotnet publish…");
run("dotnet", ["publish", "launcher/Launcher.csproj", "-c", "Release", "-o", "launcher/bin/publish", "--nologo"]);

mkdirSync(join(root, "release"), { recursive: true });
const out = join(root, "release", "3D-просмотр.exe");
copyFileSync(join(root, "launcher", "bin", "publish", "FbxViewerLauncher.exe"), out);
console.log(`[build:exe] готово: ${out} (${(statSync(out).size / 1024 / 1024).toFixed(1)} МБ)`);
