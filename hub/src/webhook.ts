import type { FleetEvent } from "./types";

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function pushHelmWebhook(
  webhookUrl: string,
  webhookSecret: string | null,
  events: FleetEvent[],
): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (!webhookUrl || events.length === 0) {
    return { ok: true };
  }

  const body = JSON.stringify({
    source: "flagship-hub",
    sentAt: new Date().toISOString(),
    eventCount: events.length,
    summary: events.map((e) => e.summary).join(" | "),
    events: events.map((e) => ({
      id: e.id,
      kind: e.kind,
      nodeId: e.nodeId,
      threadId: e.threadId,
      summary: e.summary,
      payload: e.payload,
      createdAt: e.createdAt,
    })),
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Flagship-Event": events[0]?.kind ?? "batch",
    "X-Flagship-Event-Id": String(events[events.length - 1]?.id ?? 0),
  };

  if (webhookSecret) {
    const digest = await hmacSha256Hex(webhookSecret, body);
    headers["X-Flagship-Signature"] = `sha256=${digest}`;
  }

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers,
      body,
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: await res.text() };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
