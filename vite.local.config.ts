import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Статическая сборка вьювера для exe-версии (launcher/): без сервера сайта, без админки.
 * Результат — dist-local/, его вшивает в exe `npm run build:exe`.
 */
const root = fileURLToPath(new URL("./local", import.meta.url));

export default defineConfig({
  root,
  base: "./",
  publicDir: false,
  plugins: [viteReact(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    outDir: fileURLToPath(new URL("./dist-local", import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
  },
});
