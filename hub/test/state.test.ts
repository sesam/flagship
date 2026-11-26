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

  it("auto-marks a dispatched idea as done when its linked thread completes", async () => {
    const db = new DatabaseSync(":memory:");
    const hub = new FlagshipHubCore(createSqliteAdapter(db), "0.1.0", async () => ({ ok: true }));

    const created = await reqJson(hub, "/api/ideas", "POST", { title: "Ship auth fix", priority: "P1" });
    const ideaId = String(created.data.id);
    await reqJson(hub, `/api/ideas/${ideaId}`, "PATCH", {
      status: "dispatched",
      threadId: "t-auth-1",
    });

    // Baseline: running
    await reqJson(
      hub,
      "/api/nodes/heartbeat",
      "POST",
      makeHeartbeat([{ threadId: "t-auth-1", title: "Ship auth fix", status: "running", itemCount: 1 }]),
    );
    // Transition: completed
    await reqJson(
      hub,
      "/api/nodes/heartbeat",
      "POST",
      makeHeartbeat([{ threadId: "t-auth-1", title: "Ship auth fix", status: "completed", itemCount: 4 }]),
    );

    const ideasRes = await reqJson(hub, "/api/ideas");
    const idea = (ideasRes.data.ideas as Array<{ id: string; status: string }>).find((i) => i.id === ideaId);
    expect(idea?.status).toBe("done");
  });
});

describe("FlagshipHubCore proactive Discord alerts", () => {
  it("ingests alerts, pushes discord_alert webhook, dedupes active/cooldown alerts, and re-opens after cooldown", async () => {
    const db = new DatabaseSync(":memory:");
    const pushedBatches: FleetEvent[][] = [];
    const hub = new FlagshipHubCore(createSqliteAdapter(db), "0.1.0", async (_url, _secret, events) => {
      pushedBatches.push(events);
      return { ok: true, status: 200 };
    });

    await reqJson(hub, "/api/control/webhook", "POST", {
      url: "https://t3.test/hooks/helm",
    });

    // 1. Fresh alert ingest -> 201 + discord_alert webhook push
    const first = await reqJson(hub, "/api/alerts", "POST", {
      alertKey: "frontend:missing-prime-icon:pi-bolt",
      repo: "FRONTEND",
      channelId: "111222333444555666",
      messageId: "999888777666555444",
      source: "notify-discord",
      severity: "bug",
      summary: "PrimeIcons glyph missing: pi-bolt",
      text: "PrimeIcons glyph missing on /app icon: pi-bolt",
      silentFirst: false,
    });
    expect(first.status).toBe(201);
    expect(first.data.ok).toBe(true);
    expect(first.data.deduped).toBe(false);
    expect((first.data.alert as { status: string; hitCount: number }).status).toBe("open");
    expect((first.data.alert as { hitCount: number }).hitCount).toBe(1);
    expect(pushedBatches).toHaveLength(1);
    expect(pushedBatches[0][0].kind).toBe("discord_alert");
    expect(pushedBatches[0][0].summary).toBe("[Alert] (FRONTEND) PrimeIcons glyph missing: pi-bolt");
    expect(pushedBatches[0][0].payload).toMatchObject({
      alertKey: "frontend:missing-prime-icon:pi-bolt",
      repo: "FRONTEND",
      channelId: "111222333444555666",
      messageId: "999888777666555444",
      severity: "bug",
      silentFirst: false,
    });

    // Overview exposes openAlerts + counts.openAlerts
    const ov = (await reqJson(hub, "/api/overview")).data as unknown as OverviewResponse;
    expect(ov.counts.openAlerts).toBe(1);
    expect(ov.openAlerts).toHaveLength(1);
    expect(ov.openAlerts[0].alertKey).toBe("frontend:missing-prime-icon:pi-bolt");

    // 2. Duplicate while open -> 200 deduped, hitCount++, updates messageId, NO webhook push
    const dupOpen = await reqJson(hub, "/api/alerts", "POST", {
      alertKey: "frontend:missing-prime-icon:pi-bolt",
      repo: "FRONTEND",
      channelId: "111222333444555666",
      messageId: "999888777666555445",
      summary: "PrimeIcons glyph missing: pi-bolt",
    });
    expect(dupOpen.status).toBe(200);
    expect(dupOpen.data.deduped).toBe(true);
    expect((dupOpen.data.alert as { hitCount: number; messageId: string }).hitCount).toBe(2);
    expect((dupOpen.data.alert as { messageId: string }).messageId).toBe("999888777666555445");
    expect(pushedBatches).toHaveLength(1);

    // 3. Mark working, then duplicate -> still deduped, NO webhook push
    await reqJson(
      hub,
      `/api/alerts/${encodeURIComponent("frontend:missing-prime-icon:pi-bolt")}`,
      "PATCH",
      { status: "working", threadId: "th_fix_1", threadLink: "https://app.t3.codes/t/1" },
    );
    const dupWorking = await reqJson(hub, "/api/alerts", "POST", {
      alertKey: "frontend:missing-prime-icon:pi-bolt",
      summary: "PrimeIcons glyph missing: pi-bolt",
    });
    expect(dupWorking.status).toBe(200);
    expect(dupWorking.data.deduped).toBe(true);
    expect((dupWorking.data.alert as { hitCount: number; status: string }).hitCount).toBe(3);
    expect((dupWorking.data.alert as { status: string }).status).toBe("working");
    expect(pushedBatches).toHaveLength(1);

    // 4. Mark resolved -> deduped within default 6h cooldown
    await reqJson(
      hub,
      `/api/alerts/${encodeURIComponent("frontend:missing-prime-icon:pi-bolt")}`,
      "PATCH",
      { status: "resolved", note: "Fixed in abc123" },
    );
    const dupCooldown = await reqJson(hub, "/api/alerts", "POST", {
      alertKey: "frontend:missing-prime-icon:pi-bolt",
      summary: "PrimeIcons glyph missing: pi-bolt",
    });
    expect(dupCooldown.status).toBe(200);
    expect(dupCooldown.data.deduped).toBe(true);
    expect((dupCooldown.data.alert as { hitCount: number; status: string }).hitCount).toBe(4);
    expect((dupCooldown.data.alert as { status: string }).status).toBe("resolved");
    expect(pushedBatches).toHaveLength(1);

    // 5. Re-open once outside cooldown (cooldownSeconds: 0) -> 201 + webhook push again
    const reopened = await reqJson(hub, "/api/alerts", "POST", {
      alertKey: "frontend:missing-prime-icon:pi-bolt",
      repo: "FRONTEND",
      summary: "PrimeIcons glyph missing: pi-bolt (regression)",
      cooldownSeconds: 0,
    });
    expect(reopened.status).toBe(201);
    expect(reopened.data.deduped).toBe(false);
    expect((reopened.data.alert as { status: string; hitCount: number; threadId: string | null }).status).toBe("open");
    expect((reopened.data.alert as { hitCount: number }).hitCount).toBe(1);
    expect((reopened.data.alert as { threadId: string | null }).threadId).toBeNull();
    expect(pushedBatches).toHaveLength(2);

    // 6. Stand-down suppresses webhook push while still storing the alert
    await reqJson(hub, "/api/control/stand-down", "POST", { reason: "quiet hours" });
    const duringStandDown = await reqJson(hub, "/api/alerts", "POST", {
      alertKey: "backend:slow-query:orders",
      repo: "BACKEND",
      summary: "Slow query on orders",
    });
    expect(duringStandDown.status).toBe(201);
    expect(pushedBatches).toHaveLength(2);
  });

  it("calls notify-discord /alert/status on PATCH, handles errors gracefully, filters GET /api/alerts, and exposes MCP tools", async () => {
    const db = new DatabaseSync(":memory:");
    const notifyCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    let nextNotifyResponse: () => Promise<Response> = async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 });

    const mockFetch: typeof fetch = async (input, init) => {
      notifyCalls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return nextNotifyResponse();
    };

    const hub = new FlagshipHubCore(
      createSqliteAdapter(db),
      "0.1.0",
      async () => ({ ok: true }),
      undefined,
      {
        url: "https://notify-discord.42b.eu",
        token: "test-service-token",
        fetchImpl: mockFetch,
      },
    );

    await reqJson(hub, "/api/alerts", "POST", {
      alertKey: "frontend:missing-prime-icon:pi-bolt",
      repo: "FRONTEND",
      channelId: "111222333444555666",
      messageId: "999888777666555444",
      summary: "Missing icon pi-bolt",
    });
    await reqJson(hub, "/api/alerts", "POST", {
      alertKey: "backend:cron:fail",
      repo: "BACKEND",
      summary: "Cron failed",
    });

    // PATCH to working triggers notify-discord /alert/status with exact contract payload
    const patchWorking = await reqJson(
      hub,
      `/api/alerts/${encodeURIComponent("frontend:missing-prime-icon:pi-bolt")}`,
      "PATCH",
      {
        status: "working",
        threadId: "th_worker_9",
        threadLink: "https://app.t3.codes/threads/env/9",
        note: "Dispatched worktree worker",
      },
    );
    expect(patchWorking.status).toBe(200);
    expect(patchWorking.data.ok).toBe(true);
    expect(patchWorking.data.discordReaction).toEqual({ ok: true, status: 200 });
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].url).toBe("https://notify-discord.42b.eu/alert/status");
    expect(notifyCalls[0].body).toEqual({
      channelId: "111222333444555666",
      messageId: "999888777666555444",
      alertKey: "frontend:missing-prime-icon:pi-bolt",
      state: "working",
      repoPath: "https://github.com/sesam/flagship",
      token: "test-service-token",
    });

    // PATCH to resolved when notify-discord returns 502 still succeeds without crashing
    nextNotifyResponse = async () => new Response("upstream 502", { status: 502 });
    const patchResolved = await reqJson(
      hub,
      `/api/alerts/${encodeURIComponent("frontend:missing-prime-icon:pi-bolt")}`,
      "PATCH",
      { status: "resolved", note: "Shipped fix" },
    );
    expect(patchResolved.status).toBe(200);
    expect((patchResolved.data.alert as { status: string }).status).toBe("resolved");
    expect(patchResolved.data.discordReaction).toEqual({
      ok: false,
      status: 502,
      error: "upstream 502",
    });

    // GET /api/alerts default (open,working) vs ?status=all vs ?status=open
    const listDefault = await reqJson(hub, "/api/alerts");
    expect((listDefault.data.alerts as Array<{ alertKey: string }>).map((a) => a.alertKey)).toEqual([
      "backend:cron:fail",
    ]);

    const listAll = await reqJson(hub, "/api/alerts?status=all");
    expect((listAll.data.alerts as Array<{ alertKey: string }>).length).toBe(2);

    // 404 on unknown alertKey
    const missing = await reqJson(hub, "/api/alerts/no-such-alert", "PATCH", { status: "working" });
    expect(missing.status).toBe(404);

    // MCP flagship_alerts + flagship_alert_update
    nextNotifyResponse = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
    const mcpList = await reqJson(hub, "/mcp", "POST", {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "flagship_alerts", arguments: { status: "open" } },
    });
    const listedAlerts = (
      mcpList.data.result as { structuredContent: { alerts: Array<{ alertKey: string }> } }
    ).structuredContent.alerts;
    expect(listedAlerts.map((a) => a.alertKey)).toEqual(["backend:cron:fail"]);

    const mcpUpdate = await reqJson(hub, "/mcp", "POST", {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "flagship_alert_update",
        arguments: {
          alertKey: "backend:cron:fail",
          status: "false_positive",
          note: "Transient DNS blip",
        },
      },
    });
    const updated = (
      mcpUpdate.data.result as {
        structuredContent: { alert: { status: string }; discordReaction: { ok: boolean } };
      }
    ).structuredContent;
    expect(updated.alert.status).toBe("false_positive");
    expect(updated.discordReaction.ok).toBe(true);
  });

  it("migrates an already-initialized legacy DB missing the alerts table", async () => {
    const db = new DatabaseSync(":memory:");
    // Pre-populate legacy schema (pre-alerts Durable Object SQLite instance)
    db.exec(`
      CREATE TABLE control (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE nodes (
        node_id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL,
        environment_id TEXT, owner TEXT NOT NULL DEFAULT 'default',
        platform TEXT NOT NULL DEFAULT 'unknown', arch TEXT NOT NULL DEFAULT 'unknown',
        capabilities_json TEXT NOT NULL DEFAULT '[]', projects_json TEXT NOT NULL DEFAULT '[]',
        telemetry_json TEXT NOT NULL DEFAULT '{}', quota_json TEXT NOT NULL DEFAULT '{}',
        last_seen_at TEXT NOT NULL
      );
      CREATE TABLE threads (
        node_id TEXT NOT NULL, thread_id TEXT NOT NULL, project_id TEXT, project_title TEXT,
        project_path TEXT, title TEXT NOT NULL, link TEXT, status TEXT NOT NULL,
        settled INTEGER NOT NULL DEFAULT 0, snoozed INTEGER NOT NULL DEFAULT 0,
        item_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
        last_progress_at TEXT NOT NULL, stalled INTEGER NOT NULL DEFAULT 0,
        dismissed_at TEXT, PRIMARY KEY (node_id, thread_id)
      );
      CREATE TABLE ideas (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
        priority TEXT NOT NULL DEFAULT 'P2', status TEXT NOT NULL DEFAULT 'inbox',
        workload TEXT NOT NULL DEFAULT 'small', visibility TEXT NOT NULL DEFAULT 'business',
        project TEXT, assigned_node TEXT, thread_id TEXT, thread_link TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE commands (
        id TEXT PRIMARY KEY, node_id TEXT NOT NULL, kind TEXT NOT NULL,
        payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, node_id TEXT,
        thread_id TEXT, summary TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}',
        delivered INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      INSERT INTO control (key, value) VALUES ('stand_down', 'false');
    `);

    const hub = new FlagshipHubCore(createSqliteAdapter(db), "0.1.0", async () => ({ ok: true }));

    const ovRes = await reqJson(hub, "/api/overview");
    expect(ovRes.status).toBe(200);
    expect((ovRes.data as unknown as OverviewResponse).openAlerts).toEqual([]);
    expect((ovRes.data as unknown as OverviewResponse).counts.openAlerts).toBe(0);

    const listRes = await reqJson(hub, "/api/alerts");
    expect(listRes.status).toBe(200);
    expect(listRes.data.alerts).toEqual([]);

    const postRes = await reqJson(hub, "/api/alerts", "POST", {
      alertKey: "legacy:upgrade:test",
      repo: "flagship",
      summary: "Alert after legacy DO upgrade",
    });
    expect(postRes.status).toBe(201);
    expect((postRes.data.alert as { alertKey: string }).alertKey).toBe("legacy:upgrade:test");
  });
});

describe("FlagshipHubCore DO write-quota protection and corrupt-row resilience", () => {
  it("skips redundant thread and node SQL writes on unchanged heartbeats while serving live telemetry", async () => {
    const db = new DatabaseSync(":memory:");
    const baseSql = createSqliteAdapter(db);
    const writeQueries: string[] = [];
    const countingSql: SqlStorageLike = {
      exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]) {
        const upper = query.trim().toUpperCase();
        if (!upper.startsWith("SELECT") && !upper.startsWith("PRAGMA")) {
          writeQueries.push(query.trim());
        }
        return baseSql.exec<T>(query, ...bindings);
      },
    };

    const hub = new FlagshipHubCore(countingSql, "0.1.0", async () => ({ ok: true }));
    const now = new Date().toISOString();
    const threads = Array.from({ length: 15 }, (_, idx) => ({
      threadId: `th-${idx}`,
      title: `Thread ${idx}`,
      status: idx === 0 ? "running" : "idle",
      settled: idx > 5,
      snoozed: false,
      itemCount: idx + 1,
      updatedAt: now,
    }));

    // Initial baseline heartbeat writes node + 15 threads + node_online event
    await reqJson(hub, "/api/nodes/heartbeat", "POST", makeHeartbeat(threads));
    writeQueries.length = 0;

    // Next 5 heartbeats with slightly different RAM/load and identical threads: 0 SQL writes!
    for (let i = 1; i <= 5; i++) {
      const hb = makeHeartbeat(threads);
      hb.telemetry.ramFreeMb = 9000 - i * 50;
      hb.telemetry.load1m = 0.6 + i * 0.1;
      const res = await reqJson(hub, "/api/nodes/heartbeat", "POST", hb);
      expect(res.status).toBe(200);
    }
    expect(writeQueries).toHaveLength(0);

    // Overview still reflects the latest live in-memory telemetry
    const ov = (await reqJson(hub, "/api/overview")).data as unknown as OverviewResponse;
    expect(ov.nodes[0].telemetry.ramFreeMb).toBe(8750);
    expect(ov.nodes[0].telemetry.load1m).toBeCloseTo(1.1, 2);

    // Changing 1 thread status writes ONLY that thread (plus idea auto-close + event), not the other 14
    const updatedThreads = threads.map((t) =>
      t.threadId === "th-0" ? { ...t, status: "completed", itemCount: 2 } : t,
    );
    await reqJson(hub, "/api/nodes/heartbeat", "POST", makeHeartbeat(updatedThreads));
    const threadWrites = writeQueries.filter((q) => q.includes("INTO threads"));
    expect(threadWrites).toHaveLength(1);
  });

  it("serves cold-start reads and degrades heartbeats cleanly when DO free-tier write quota is exhausted", async () => {
    const db = new DatabaseSync(":memory:");
    const baseSql = createSqliteAdapter(db);

    // Seed an initialized DB with normal data
    const setupHub = new FlagshipHubCore(baseSql, "0.1.0", async () => ({ ok: true }));
    await reqJson(
      setupHub,
      "/api/nodes/heartbeat",
      "POST",
      makeHeartbeat([{ threadId: "t-live-1", title: "Live worker", status: "running", itemCount: 2 }]),
    );
    await reqJson(setupHub, "/api/ideas", "POST", { title: "Existing idea", priority: "P1" });

    // Simulate Cloudflare DO free-tier daily rows-written quota exhausted on a cold DO instance
    const writeBlockedSql: SqlStorageLike = {
      exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]) {
        const upper = query.trim().toUpperCase();
        if (!upper.startsWith("SELECT") && !upper.startsWith("PRAGMA")) {
          throw new Error("Exceeded allowed rows written in Durable Objects free tier.");
        }
        return baseSql.exec<T>(query, ...bindings);
      },
    };

    const coldHub = new FlagshipHubCore(writeBlockedSql, "0.1.0", async () => ({ ok: true }));

    // Cold-start GET /api/overview must NOT run DDL/writes and must return 200 OK
    const ovRes = await reqJson(coldHub, "/api/overview");
    expect(ovRes.status).toBe(200);
    const ov = ovRes.data as unknown as OverviewResponse;
    expect(ov.nodes).toHaveLength(1);
    expect(ov.ideas).toHaveLength(1);
    expect(ov.inFlight).toHaveLength(1);

    // Heartbeat during quota exhaustion caches live telemetry in memory without crashing
    const hb = makeHeartbeat([
      { threadId: "t-live-1", title: "Live worker", status: "running", itemCount: 5 },
    ]);
    hb.telemetry.ramFreeMb = 7777;
    const hbRes = await reqJson(coldHub, "/api/nodes/heartbeat", "POST", hb);
    expect(hbRes.status).toBe(200);
    expect(hbRes.data.ok).toBe(true);
    expect(hbRes.data.storageDegraded).toBe(true);

    const ovAfterHb = (await reqJson(coldHub, "/api/overview")).data as unknown as OverviewResponse;
    expect(ovAfterHb.nodes[0].telemetry.ramFreeMb).toBe(7777);
    expect(ovAfterHb.inFlight[0].itemCount).toBe(5);

    // Durable mutations return structured 503 JSON instead of crashing with uncaught error
    const ideaRes = await reqJson(coldHub, "/api/ideas", "POST", { title: "New idea during quota outage" });
    expect(ideaRes.status).toBe(503);
    expect(ideaRes.data.code).toBe("STORAGE_QUOTA_EXCEEDED");
  });

  it("stays operational in-memory when all SQL calls (reads + writes) throw free-tier quota error, and auto-heals after reset", async () => {
    const db = new DatabaseSync(":memory:");
    const baseSql = createSqliteAdapter(db);
    let quotaBlocked = true;

    const toggleableSql: SqlStorageLike = {
      exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]) {
        if (quotaBlocked) {
          throw new Error("Exceeded allowed rows written in Durable Objects free tier.");
        }
        return baseSql.exec<T>(query, ...bindings);
      },
    };

    const hub = new FlagshipHubCore(toggleableSql, "0.1.0", async () => ({ ok: true }));

    // Cold-start overview during full SQLite quota block still returns 200 with storageDegraded: true
    const ovEmpty = await reqJson(hub, "/api/overview");
    expect(ovEmpty.status).toBe(200);
    expect(ovEmpty.data.storageDegraded).toBe(true);

    // Heartbeat populates live in-memory nodes and threads without crashing
    const hb = makeHeartbeat([
      { threadId: "t-degraded-1", title: "Live task", status: "running", itemCount: 3 },
    ]);
    hb.telemetry.ramFreeMb = 8888;
    const hbRes = await reqJson(hub, "/api/nodes/heartbeat", "POST", hb);
    expect(hbRes.status).toBe(200);
    expect(hbRes.data.storageDegraded).toBe(true);

    // Overview and route immediately reflect the live node & thread
    const ovLive = (await reqJson(hub, "/api/overview")).data as unknown as OverviewResponse;
    expect(ovLive.storageDegraded).toBe(true);
    expect(ovLive.counts.nodesOnline).toBe(1);
    expect(ovLive.nodes[0].telemetry.ramFreeMb).toBe(8888);
    expect(ovLive.inFlight).toHaveLength(1);

    const routeRes = await reqJson(hub, "/api/route", "POST", { title: "Research pricing" });
    expect(routeRes.status).toBe(200);
    expect((routeRes.data.selectedNode as { nodeId: string }).nodeId).toBe("cloud-vm");

    // Durable mutations honestly return 503 STORAGE_QUOTA_EXCEEDED
    const ideaBlocked = await reqJson(hub, "/api/ideas", "POST", { title: "Blocked idea" });
    expect(ideaBlocked.status).toBe(503);
    expect(ideaBlocked.data.code).toBe("STORAGE_QUOTA_EXCEEDED");

    // Simulate 00:00 UTC quota reset -> hub auto-heals on next request and persists to SQLite
    quotaBlocked = false;
    const hbRecovered = await reqJson(hub, "/api/nodes/heartbeat", "POST", hb);
    expect(hbRecovered.status).toBe(200);
    expect(hbRecovered.data.storageDegraded).toBeUndefined();

    const ideaOk = await reqJson(hub, "/api/ideas", "POST", { title: "Persisted after reset" });
    expect(ideaOk.status).toBe(201);

    const ovRecovered = (await reqJson(hub, "/api/overview")).data as unknown as OverviewResponse;
    expect(ovRecovered.storageDegraded).toBeUndefined();
    expect(ovRecovered.nodes).toHaveLength(1);
    expect(ovRecovered.ideas).toHaveLength(1);
  });

  it("handles corrupt JSON columns and partial telemetry rows without crashing overview or routing", async () => {
    const db = new DatabaseSync(":memory:");
    const baseSql = createSqliteAdapter(db);
    const hub = new FlagshipHubCore(baseSql, "0.1.0", async () => ({ ok: true }));

    // Initialize schema via a read
    await reqJson(hub, "/api/overview");

    // Inject corrupt rows directly into SQLite
    db.prepare(
      `INSERT INTO nodes (
        node_id, name, role, environment_id, owner, platform, arch,
        capabilities_json, projects_json, telemetry_json, quota_json, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "corrupt-node",
      "Corrupt Node",
      "vm",
      null,
      "ops",
      "linux",
      "x64",
      "{not-valid-json",
      "null",
      "{broken-telemetry",
      "broken-quota",
      "not-a-timestamp",
    );
    db.prepare(
      `INSERT INTO events (kind, node_id, thread_id, summary, payload_json, delivered, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("test_event", "corrupt-node", null, "Corrupt payload event", "{bad-json", 0, new Date().toISOString());

    const ovRes = await reqJson(hub, "/api/overview");
    expect(ovRes.status).toBe(200);
    const ov = ovRes.data as unknown as OverviewResponse;
    expect(ov.nodes).toHaveLength(1);
    expect(ov.nodes[0].status).toBe("offline");
    expect(ov.nodes[0].telemetry.load1m).toBe(0);
    expect(ov.nodes[0].capabilities).toEqual([]);
    expect(ov.nodes[0].projects).toEqual([]);
    expect(ov.recentEvents[0].payload).toEqual({});

    const routeRes = await reqJson(hub, "/api/route", "POST", { title: "Check routing with corrupt row" });
    expect(routeRes.status).toBe(200);
  });
});
