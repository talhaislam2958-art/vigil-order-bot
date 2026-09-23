import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/admin")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = await request.json();
          const { handleAdminRequest } = await import("@/lib/admin-api.server");
          const result = await handleAdminRequest(body);
          return Response.json({ result }, { headers: { "Cache-Control": "no-store" } });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Request failed";
          const status = /unauthor|session/i.test(message) ? 401 : 400;
          return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
        }
      },
    },
  },
});
