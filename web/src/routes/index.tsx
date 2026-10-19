import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Job Autopilot — Dashboard" },
      { name: "description", content: "Track and control your automatic job applications." },
      { property: "og:title", content: "Job Autopilot — Dashboard" },
      { property: "og:description", content: "Track and control your automatic job applications." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  beforeLoad: () => {
    throw redirect({ to: "/overview" });
  },
});
