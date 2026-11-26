import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { FlagshipHubCore, type SqlStorageLike } from "../src/core";
import type { FleetEvent, HeartbeatPayload, OverviewResponse } from "../src/types";

function createSqliteAdapter(db: DatabaseSync): SqlStorageLike {
  return {
    exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]) {
      const trimmed = query.trim();
      if (bindings.length === 0 && trimmed.includes(";")) {
        db.exec(trimmed);
        return { toArray: () => [] as T[] };
      }
      const stmt = db.prepare(trimmed);
      const upper = trimmed.toUpperCase();
      if (upper.startsWith("SELECT") || upper.startsWith("PRAGMA")) {
        const rows = stmt.all(...(bindings as never[])) as T[];
        return { toArray: () => rows };
      }
      stmt.run(...(bindings as never[]));
      return { toArray: () => [] as T[] };
    },
  };
}

function makeHeartbeat(threads: HeartbeatPayload["threads"] = []): HeartbeatPayload {
  return {
    nodeId: "cloud-vm",
    name: "Cloud VM",
    role: "vm",
    telemetry: {
      ramTotalMb: 16000,
      ramFreeMb: 9000,
      ramUsedPct: 44,
      cpuCores: 4,
      load1m: 0.6,
      diskFreeGb: 40,
      activeThreads: threads?.filter((t) => t.status === "running").length ?? 0,
      maxSlots: 6,
      devices: [],
    },
    threads,
  };
}

async function reqJson(
  hub: FlagshipHubCore,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await hub.fetch(
    new Request(`https://flagship.test${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

describe("FlagshipHubCore self-wakeup suppression", () => {
  it("never emits or pushes wakeup events when threadId matches helm_thread_id", async () => {
    const db = new DatabaseSync(":memory:");
    const pushedBatches: FleetEvent[][] = [];
    const hub = new FlagshipHubCore(createSqliteAdapter(db), "0.1.0", async (_url, _secret, events) => {
      pushedBatches.push(events);
      return { ok: true, status: 200 };
    });

    // Configure webhook + helm_thread_id
    const wh = await reqJson(hub, "/api/control/webhook", "POST", {
      url: "https://t3.test/hooks/helm",
      threadId: "thread-helm-home",
    });
    expect(wh.status).toBe(200);
    expect(wh.data.configured).toBe(true);
    expect(wh.data.helmThreadId).toBe("thread-helm-home");

    // Baseline heartbeat: node comes online + both threads running
    await reqJson(
      hub,
      "/api/nodes/heartbeat",
      "POST",
      makeHeartbeat([
        { threadId: "thread-helm-home", title: "Helm Home", status: "running", itemCount: 1 },
        { threadId: "thread-worker-1", title: "Worker PR", status: "running", itemCount: 1 },
      ]),
    );
    // Clear initial node_online push
    pushedBatches.length = 0;

    // Helm Home thread finishes (running -> idle): must NOT emit or push!
    const hbHelmDone = await reqJson(
      hub,
      "/api/nodes/heartbeat",
      "POST",
      makeHeartbeat([
        { threadId: "thread-helm-home", title: "Helm Home", status: "idle", itemCount: 2 },
        { threadId: "thread-worker-1", title: "Worker PR", status: "running", itemCount: 2 },
      ]),
    );
    expect(hbHelmDone.data.eventsRecorded).toBe(0);
    expect(pushedBatches).toHaveLength(0);

    // Worker thread completes (running -> completed): MUST emit and push!
    const hbWorkerDone = await reqJson(
      hub,
      "/api/nodes/heartbeat",
      "POST",
      makeHeartbeat([
        { threadId: "thread-helm-home", title: "Helm Home", status: "idle", itemCount: 2 },
        { threadId: "thread-worker-1", title: "Worker PR", status: "completed", itemCount: 3 },
      ]),
    );
    expect(hbWorkerDone.data.eventsRecorded).toBe(1);
    expect(pushedBatches).toHaveLength(1);
    expect(pushedBatches[0][0].kind).toBe("thread_completed");
    expect(pushedBatches[0][0].threadId).toBe("thread-worker-1");
  });
});

describe("FlagshipHubCore thread dismissal", () => {
  it("excludes dismissed failed threads from needsAttention and clears dismissal if the thread runs again", async () => {
    const db = new DatabaseSync(":memory:");
    const hub = new FlagshipHubCore(createSqliteAdapter(db), "0.1.0", async () => ({ ok: true }));
    const now = new Date().toISOString();

    await reqJson(
      hub,
      "/api/nodes/heartbeat",
      "POST",
      makeHeartbeat([
        { threadId: "t-fail-1", title: "Old failed build", status: "failed", updatedAt: now },
        { threadId: "t-fail-2", title: "Interrupted job", status: "interrupted", updatedAt: now },
        { threadId: "t-wait-1", title: "Needs decision", status: "waiting", updatedAt: now },
      ]),
    );

    let ov = (await reqJson(hub, "/api/overview")).data as unknown as OverviewResponse;
    expect(ov.needsAttention.map((t) => t.threadId).sort()).toEqual([
      "t-fail-1",
      "t-fail-2",
      "t-wait-1",
    ]);

    // Dismiss a single failed thread
    const d1 = await reqJson(hub, "/api/threads/dismiss", "POST", { threadId: "t-fail-1" });
    expect(d1.status).toBe(200);
    expect(d1.data.dismissedCount).toBe(1);

    ov = (await reqJson(hub, "/api/overview")).data as unknown as OverviewResponse;
    expect(ov.needsAttention.map((t) => t.threadId).sort()).toEqual(["t-fail-2", "t-wait-1"]);

    // Dismiss remaining failed/interrupted threads via MCP flagship_dismiss
    const mcpRes = await reqJson(hub, "/mcp", "POST", {
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name: "flagship_dismiss", arguments: { allFailed: true } },
    });
    expect(mcpRes.status).toBe(200);
    const structured = (mcpRes.data.result as { structuredContent: { dismissedCount: number } })
      .structuredContent;
    expect(structured.dismissedCount).toBe(1);

    ov = (await reqJson(hub, "/api/overview")).data as unknown as OverviewResponse;
    expect(ov.needsAttention.map((t) => t.threadId)).toEqual(["t-wait-1"]);

    // Heartbeat while t-fail-1 is still failed -> stays dismissed
    await reqJson(
      hub,
      "/api/nodes/heartbeat",
      "POST",
      makeHeartbeat([
        { threadId: "t-fail-1", title: "Old failed build", status: "failed", updatedAt: now },
        { threadId: "t-fail-2", title: "Interrupted job", status: "interrupted", updatedAt: now },
        { threadId: "t-wait-1", title: "Needs decision", status: "waiting", updatedAt: now },
      ]),
    );
    ov = (await reqJson(hub, "/api/overview")).data as unknown as OverviewResponse;
    expect(ov.needsAttention.map((t) => t.threadId)).toEqual(["t-wait-1"]);

    // Dismissed thread t-fail-1 transitions back to running -> dismissal automatically clears
    const later = new Date(Date.now() + 1000).toISOString();
    await reqJson(
      hub,
      "/api/nodes/heartbeat",
      "POST",
      makeHeartbeat([
        { threadId: "t-fail-1", title: "Old failed build", status: "running", updatedAt: later },
        { threadId: "t-fail-2", title: "Interrupted job", status: "interrupted", updatedAt: now },
        { threadId: "t-wait-1", title: "Needs decision", status: "waiting", updatedAt: now },
      ]),
    );

    // If t-fail-1 fails again later, it must re-surface in needsAttention
    const evenLater = new Date(Date.now() + 2000).toISOString();
    await reqJson(
      hub,
      "/api/nodes/heartbeat",
      "POST",
      makeHeartbeat([
        { threadId: "t-fail-1", title: "Old failed build", status: "failed", updatedAt: evenLater },
        { threadId: "t-fail-2", title: "Interrupted job", status: "interrupted", updatedAt: now },
        { threadId: "t-wait-1", title: "Needs decision", status: "waiting", updatedAt: now },
      ]),
    );
    ov = (await reqJson(hub, "/api/overview")).data as unknown as OverviewResponse;
    expect(ov.needsAttention.map((t) => t.threadId).sort()).toEqual(["t-fail-1", "t-wait-1"]);
  });

  it("migrates legacy threads tables missing the dismissed_at column", async () => {
    const db = new DatabaseSync(":memory:");
    // Simulate pre-existing Durable Object table without dismissed_at
    db.exec(`
      CREATE TABLE threads (
        node_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        project_id TEXT,
        project_title TEXT,
        project_path TEXT,
        title TEXT NOT NULL,
        link TEXT,
        status TEXT NOT NULL,
        settled INTEGER NOT NULL DEFAULT 0,
        snoozed INTEGER NOT NULL DEFAULT 0,
        item_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        last_progress_at TEXT NOT NULL,
        stalled INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (node_id, thread_id)
      );
    `);

    const hub = new FlagshipHubCore(createSqliteAdapter(db), "0.1.0", async () => ({ ok: true }));
    const res = await reqJson(hub, "/api/threads/dismiss", "POST", { allFailed: true });
    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
  });
});

describe("FlagshipHubCore security controls", () => {
  it("rejects unsafe webhook URLs (non-HTTPS or cloud metadata hosts) and omits wildcard CORS by default", async () => {
    const db = new DatabaseSync(":memory:");
    const hub = new FlagshipHubCore(createSqliteAdapter(db), "0.1.0", async () => ({ ok: true }));

    const badScheme = await reqJson(hub, "/api/control/webhook", "POST", {
      url: "http://evil.example.com/hook",
    });
    expect(badScheme.status).toBe(400);

    const badMeta = await reqJson(hub, "/api/control/webhook", "POST", {
      url: "https://169.254.169.254/latest/meta-data",
    });
    expect(badMeta.status).toBe(400);

    const goodHttps = await reqJson(hub, "/api/control/webhook", "POST", {
      url: "https://hooks.example.com/flagship",
    });
    expect(goodHttps.status).toBe(200);

    const res = await hub.fetch(new Request("https://flagship.test/api/overview"));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
