import { createFileRoute } from "@tanstack/react-router";
import { readPreview } from "@/lib/projects";

/**
 * Картинка-превью проекта для карточки ссылки в мессенджерах (og:image).
 * Хранилище приватное — отдаём через сайт; ?v=<версия> в og:image сбрасывает кэш при пересъёмке.
 */
export const Route = createFileRoute("/preview/$slug")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const bytes = await readPreview(params.slug);
        if (!bytes) return new Response("Not found", { status: 404 });
        return new Response(bytes as BodyInit, {
          headers: {
            "content-type": "image/jpeg",
            "cache-control": "public, max-age=300, s-maxage=86400",
          },
        });
      },
    },
  },
});
