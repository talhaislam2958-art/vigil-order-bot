// Public cron endpoint hit by pg_cron every 10 seconds. Runs a polling cycle
// across all active bot users. Auth via Supabase anon `apikey` header.

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/poll")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = request.headers.get("apikey") || request.headers.get("x-api-key");
        if (!apiKey || apiKey !== process.env.SUPABASE_PUBLISHABLE_KEY) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        const { runPollCycle } = await import("@/lib/bot-engine.server");
        const result = await runPollCycle(8000);
        return Response.json({ ok: true, ...result, at: new Date().toISOString() });
      },
      GET: async () =>
        new Response(JSON.stringify({ ok: true, hint: "POST with apikey header" }), {
          headers: { "Content-Type": "application/json" },
        }),
    },
  },
});
