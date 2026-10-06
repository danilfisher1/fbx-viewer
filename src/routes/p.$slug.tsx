import { createFileRoute } from "@tanstack/react-router";
import ViewerUI from "@/components/ViewerUI";
import { getProjectBySlug } from "@/lib/projects";

/** Ссылка для архитекторов: /p/<slug> — модель грузится с Яндекс Диска сама, ничего выбирать не нужно. */
export const Route = createFileRoute("/p/$slug")({
  loader: ({ params }) => getProjectBySlug({ data: { slug: params.slug } }),
  // Карточка ссылки в Telegram/WhatsApp/почте: название + снимок модели (снимается в админ-режиме кнопкой «Превью»).
  head: ({ loaderData: p }) => {
    if (!p) return { meta: [{ title: "Проект не найден" }] };
    const url = `${p.origin}/p/${p.slug}`;
    const description = "3D-модель ВПМ / НПМ — откройте в браузере, ничего устанавливать не нужно";
    const meta: Array<Record<string, string>> = [
      { title: `${p.name} — 3D` },
      { name: "description", content: description },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "3D-просмотр" },
      { property: "og:title", content: p.name },
      { property: "og:description", content: description },
      { property: "og:url", content: url },
      { name: "twitter:title", content: p.name },
      { name: "twitter:description", content: description },
    ];
    if (p.previewVersion) {
      const image = `${p.origin}/preview/${p.slug}?v=${p.previewVersion}`;
      meta.push(
        { property: "og:image", content: image },
        { property: "og:image:width", content: "1200" },
        { property: "og:image:height", content: "630" },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:image", content: image }
      );
    }
    return { meta };
  },
  component: ProjectPage,
});

function ProjectPage() {
  const project = Route.useLoaderData();
  if (!project) {
    return (
      <div className="viewer-root">
        <div className="drop-zone">
          <div className="drop-content">
            <h1>Проект не найден</h1>
            <p className="subtitle">Ссылка устарела или проект удалён. Попросите новую ссылку.</p>
          </div>
        </div>
      </div>
    );
  }
  return <ViewerUI remote={project} />;
}
