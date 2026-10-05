import { createFileRoute } from "@tanstack/react-router";
import ViewerUI from "@/components/ViewerUI";
import { getProjectBySlug } from "@/lib/projects";

/** Ссылка для архитекторов: /p/<slug> — модель грузится с Яндекс Диска сама, ничего выбирать не нужно. */
export const Route = createFileRoute("/p/$slug")({
  loader: ({ params }) => getProjectBySlug({ data: { slug: params.slug } }),
  head: ({ loaderData }) => ({ meta: [{ title: loaderData ? `${loaderData.name} — 3D` : "Проект не найден" }] }),
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
