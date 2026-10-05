import { createFileRoute } from "@tanstack/react-router";
import ViewerUI from "@/components/ViewerUI";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <ViewerUI />;
}
