import { FlagshipHub } from "./state";
import type { Env } from "./types";

export { FlagshipHub };

function constantTimeEquals(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) {
    diff |= ab[i] ^ bb[i];
  }
  return diff === 0;
}

function corsHeaders(corsOrigin?: string): Record<string, string> {
  const origin = corsOrigin?.trim();
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    Vary: "Origin",
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(env.CORS_ORIGIN);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    if (url.pathname === "/health" || url.pathname === "/") {
      return new Response(
        JSON.stringify({
          ok: true,
          service: "flagship-hub",
          version: env.FLAGSHIP_VERSION ?? "0.1.0",
          endpoints: ["/health", "/api/overview", "/api/nodes/heartbeat", "/api/route", "/api/dispatch", "/api/ideas", "/api/alerts", "/mcp"],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
        },
      );
    }

    const expectedToken = env.FLAGSHIP_TOKEN?.trim();
    if (!expectedToken) {
      return new Response(
        JSON.stringify({ error: "Server misconfigured: FLAGSHIP_TOKEN secret is not set" }),
        { status: 503, headers: { "Content-Type": "application/json", ...cors } },
      );
    }

    const auth = request.headers.get("Authorization") ?? "";
    const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!provided || !constantTimeEquals(provided, expectedToken)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...cors },
      });
    }

    const id = env.FLAGSHIP_HUB.idFromName("primary");
    const stub = env.FLAGSHIP_HUB.get(id);
    return stub.fetch(request);
  },
};
