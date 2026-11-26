import { handleMcpRequest } from "./mcp";
import { buildRebalanceSuggestions, inferWorkload, routeTask } from "./router";
import type {
  CommandRecord,
  FleetEvent,
  HeartbeatPayload,
  IdeaRecord,
  NodeRecord,
  OverviewResponse,
  Priority,
  RouteRequest,
  StoredThread,
  TaskVisibility,
} from "./types";
import { pushHelmWebhook } from "./webhook";

const STALE_NODE_MS = 90_000;
const OFFLINE_NODE_MS = 300_000;
const STALL_THREAD_MS = 20 * 60_000; // 20 min without itemCount/update movement while running
const MAX_STORED_EVENTS = 500;
const MAX_FINISHED_COMMANDS = 200;

export interface SqlCursorLike<T = Record<string, unknown>> {
  toArray(): T[];
}

export interface SqlStorageLike {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursorLike<T>;
}

export type WebhookPusher = typeof pushHelmWebhook;

export function validateWebhookUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Invalid webhook URL");
  }
  const host = parsed.hostname.toLowerCase();
  const isLocalDev = host === "localhost" || host === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalDev)) {
    throw new Error("Webhook URL must use https:// (or http://localhost for local dev)");
  }
  if (host === "169.254.169.254" || host === "metadata.google.internal") {
    throw new Error("Webhook URL host is not allowed");
  }
  return parsed.toString();
}

function makeJsonResponse(data: unknown, status = 200, corsOrigin?: string): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
  };
  const origin = corsOrigin?.trim();
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
    headers["Access-Control-Allow-Methods"] = "GET, POST, PATCH, DELETE, OPTIONS";
    headers["Vary"] = "Origin";
  }
  return new Response(JSON.stringify(data, null, 2), { status, headers });
}

function nowIso(): string {
  return new Date().toISOString();
}

function shortId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export class FlagshipHubCore {
  private initialized = false;

  constructor(
    private readonly sql: SqlStorageLike,
    private readonly version = "0.1.0",
    private readonly webhookPusher: WebhookPusher = pushHelmWebhook,
    private readonly corsOrigin?: string,
  ) {}

  private json(data: unknown, status = 200): Response {
    return makeJsonResponse(data, status, this.corsOrigin);
  }

  private ensureSchema(): void {
    if (this.initialized) return;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS control (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS nodes (
        node_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        environment_id TEXT,
        owner TEXT NOT NULL DEFAULT 'default',
        platform TEXT NOT NULL DEFAULT 'unknown',
        arch TEXT NOT NULL DEFAULT 'unknown',
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        projects_json TEXT NOT NULL DEFAULT '[]',
        telemetry_json TEXT NOT NULL DEFAULT '{}',
        quota_json TEXT NOT NULL DEFAULT '{}',
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS threads (
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
        dismissed_at TEXT,
        PRIMARY KEY (node_id, thread_id)
      );

      CREATE TABLE IF NOT EXISTS ideas (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        priority TEXT NOT NULL DEFAULT 'P2',
        status TEXT NOT NULL DEFAULT 'inbox',
        workload TEXT NOT NULL DEFAULT 'small',
        visibility TEXT NOT NULL DEFAULT 'business',
        project TEXT,
        assigned_node TEXT,
        thread_id TEXT,
        thread_link TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        node_id TEXT,
        thread_id TEXT,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        delivered INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `);

    const threadCols = this.sql
      .exec<{ name: string }>("PRAGMA table_info(threads)")
      .toArray();
    if (!threadCols.some((c) => c.name === "dismissed_at")) {
      this.sql.exec("ALTER TABLE threads ADD COLUMN dismissed_at TEXT");
    }

    this.initialized = true;
  }

  private getControl(key: string): string | null {
    const rows = this.sql
      .exec<{ value: string }>("SELECT value FROM control WHERE key = ?", key)
      .toArray();
    return rows[0]?.value ?? null;
  }

  private setControl(key: string, value: string): void {
    this.sql.exec(
      "INSERT INTO control (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  private isStandDown(): { standDown: boolean; reason: string | null } {
    return {
      standDown: this.getControl("stand_down") === "true",
      reason: this.getControl("stand_down_reason"),
    };
  }

  private listNodes(): NodeRecord[] {
    const now = Date.now();
    const rows = this.sql
      .exec<{
        node_id: string;
        name: string;
        role: string;
        environment_id: string | null;
        owner: string;
        platform: string;
        arch: string;
        capabilities_json: string;
        projects_json: string;
        telemetry_json: string;
        quota_json: string;
        last_seen_at: string;
      }>("SELECT * FROM nodes ORDER BY name ASC")
      .toArray();

    return rows.map((r) => {
      const ageMs = now - Date.parse(r.last_seen_at);
      const status: NodeRecord["status"] =
        ageMs > OFFLINE_NODE_MS ? "offline" : ageMs > STALE_NODE_MS ? "stale" : "online";
      const quota = JSON.parse(r.quota_json || "{}");
      return {
        nodeId: r.node_id,
        name: r.name,
        role: r.role as NodeRecord["role"],
        environmentId: r.environment_id,
        owner: r.owner,
        platform: r.platform,
        arch: r.arch,
        capabilities: JSON.parse(r.capabilities_json || "[]"),
        projects: JSON.parse(r.projects_json || "[]"),
        telemetry: JSON.parse(r.telemetry_json || "{}"),
        quota: {
          businessMaxSharePct: quota.businessMaxSharePct ?? 90,
          spotMinFreeRamPct: quota.spotMinFreeRamPct ?? 50,
        },
        status,
        lastSeenAt: r.last_seen_at,
      };
    });
  }

  private listThreads(): StoredThread[] {
    const rows = this.sql
      .exec<{
        node_id: string;
        thread_id: string;
        project_id: string | null;
        project_title: string | null;
        project_path: string | null;
        title: string;
        link: string | null;
        status: string;
        settled: number;
        snoozed: number;
        item_count: number;
        updated_at: string;
        last_progress_at: string;
        stalled: number;
        dismissed_at: string | null;
      }>("SELECT * FROM threads ORDER BY updated_at DESC LIMIT 200")
      .toArray();

    return rows.map((r) => ({
      nodeId: r.node_id,
      threadId: r.thread_id,
      projectId: r.project_id,
      projectTitle: r.project_title,
      projectPath: r.project_path,
      title: r.title,
      link: r.link,
      status: r.status,
      settled: Boolean(r.settled),
      snoozed: Boolean(r.snoozed),
      itemCount: r.item_count,
      updatedAt: r.updated_at,
      lastProgressAt: r.last_progress_at,
      stalled: Boolean(r.stalled),
      dismissedAt: r.dismissed_at ?? null,
    }));
  }

  private listIdeas(): IdeaRecord[] {
    const rows = this.sql
      .exec<{
        id: string;
        title: string;
        notes: string;
        priority: string;
        status: string;
        workload: string;
        visibility: string;
        project: string | null;
        assigned_node: string | null;
        thread_id: string | null;
        thread_link: string | null;
        created_at: string;
        updated_at: string;
      }>(
        "SELECT * FROM ideas ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END, updated_at DESC LIMIT 200",
      )
      .toArray();

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      notes: r.notes,
      priority: r.priority as Priority,
      status: r.status as IdeaRecord["status"],
      workload: r.workload as IdeaRecord["workload"],
      visibility: r.visibility as TaskVisibility,
      project: r.project,
      assignedNode: r.assigned_node,
      threadId: r.thread_id,
      threadLink: r.thread_link,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  private listEvents(limit = 25): FleetEvent[] {
    const safeLimit = Math.max(1, Math.min(100, limit));
    const rows = this.sql
      .exec<{
        id: number;
        kind: string;
        node_id: string | null;
        thread_id: string | null;
        summary: string;
        payload_json: string;
        delivered: number;
        created_at: string;
      }>("SELECT * FROM events ORDER BY id DESC LIMIT ?", safeLimit)
      .toArray();

    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      nodeId: r.node_id,
      threadId: r.thread_id,
      summary: r.summary,
      payload: JSON.parse(r.payload_json || "{}"),
      delivered: Boolean(r.delivered),
      createdAt: r.created_at,
    }));
  }

  private recordEvent(
    kind: string,
    nodeId: string | null,
    threadId: string | null,
    summary: string,
    payload: Record<string, unknown> = {},
  ): FleetEvent {
    const createdAt = nowIso();
    this.sql.exec(
      "INSERT INTO events (kind, node_id, thread_id, summary, payload_json, delivered, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
      kind,
      nodeId,
      threadId,
      summary,
      JSON.stringify(payload),
      createdAt,
    );
    const idRow = this.sql
      .exec<{ id: number }>("SELECT last_insert_rowid() AS id")
      .toArray()[0];
    this.sql.exec(
      "DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?)",
      MAX_STORED_EVENTS,
    );
    return {
      id: idRow?.id ?? 0,
      kind,
      nodeId,
      threadId,
      summary,
      payload,
      delivered: false,
      createdAt,
    };
  }

  private async maybePushWebhook(events: FleetEvent[]): Promise<void> {
    if (events.length === 0) return;
    if (this.isStandDown().standDown) return;
    const url = this.getControl("helm_webhook_url");
    if (!url) return;
    const helmThreadId = this.getControl("helm_thread_id")?.trim() || null;
    const outbound = helmThreadId
      ? events.filter((e) => !e.threadId || e.threadId !== helmThreadId)
      : events;
    if (outbound.length === 0) return;

    const secret = this.getControl("helm_webhook_secret");
    const res = await this.webhookPusher(url, secret, outbound);
    if (res.ok) {
      for (const e of outbound) {
        this.sql.exec("UPDATE events SET delivered = 1 WHERE id = ?", e.id);
      }
    }
  }

  private claimPendingCommands(nodeId: string): CommandRecord[] {
    const now = nowIso();
    const rows = this.sql
      .exec<{
        id: string;
        node_id: string;
        kind: string;
        payload_json: string;
        status: string;
        result_json: string | null;
        created_at: string;
        updated_at: string;
      }>(
        "SELECT * FROM commands WHERE node_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 10",
        nodeId,
      )
      .toArray();

    for (const r of rows) {
      this.sql.exec(
        "UPDATE commands SET status = 'claimed', updated_at = ? WHERE id = ?",
        now,
        r.id,
      );
    }

    return rows.map((r) => ({
      id: r.id,
      nodeId: r.node_id,
      kind: r.kind as CommandRecord["kind"],
      payload: JSON.parse(r.payload_json || "{}"),
      status: "claimed",
      result: null,
      createdAt: r.created_at,
      updatedAt: now,
    }));
  }

  private async handleHeartbeat(payload: HeartbeatPayload): Promise<Response> {
    if (!payload.nodeId || !payload.name || !payload.role || !payload.telemetry) {
      return this.json({ error: "nodeId, name, role, and telemetry are required" }, 400);
    }

    const now = nowIso();
    const nowMs = Date.now();
    const helmThreadId = this.getControl("helm_thread_id")?.trim() || null;

    const prevNode = this.sql
      .exec<{ last_seen_at: string }>(
        "SELECT last_seen_at FROM nodes WHERE node_id = ?",
        payload.nodeId,
      )
      .toArray()[0];

    this.sql.exec(
      `INSERT INTO nodes (
        node_id, name, role, environment_id, owner, platform, arch,
        capabilities_json, projects_json, telemetry_json, quota_json, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET
        name = excluded.name,
        role = excluded.role,
        environment_id = excluded.environment_id,
        owner = excluded.owner,
        platform = excluded.platform,
        arch = excluded.arch,
        capabilities_json = excluded.capabilities_json,
        projects_json = excluded.projects_json,
        telemetry_json = excluded.telemetry_json,
        quota_json = excluded.quota_json,
        last_seen_at = excluded.last_seen_at`,
      payload.nodeId,
      payload.name,
      payload.role,
      payload.environmentId ?? null,
      payload.owner ?? "default",
      payload.platform ?? "unknown",
      payload.arch ?? "unknown",
      JSON.stringify(payload.capabilities ?? []),
      JSON.stringify(payload.projects ?? []),
      JSON.stringify(payload.telemetry),
      JSON.stringify(payload.quota ?? { businessMaxSharePct: 90, spotMinFreeRamPct: 50 }),
      now,
    );

    const newEvents: FleetEvent[] = [];

    if (!prevNode || nowMs - Date.parse(prevNode.last_seen_at) > OFFLINE_NODE_MS) {
      newEvents.push(
        this.recordEvent(
          "node_online",
          payload.nodeId,
          null,
          `${payload.name} (${payload.role}) came online with ${payload.telemetry.ramFreeMb}MB RAM free.`,
          { role: payload.role, ramFreeMb: payload.telemetry.ramFreeMb },
        ),
      );
    }

    // Reconcile observed T3 threads & detect state transitions
    if (Array.isArray(payload.threads)) {
      for (const th of payload.threads) {
        if (!th.threadId) continue;
        const prev = this.sql
          .exec<{
            status: string;
            item_count: number;
            last_progress_at: string;
            stalled: number;
            updated_at: string;
            dismissed_at: string | null;
          }>(
            "SELECT status, item_count, last_progress_at, stalled, updated_at, dismissed_at FROM threads WHERE node_id = ? AND thread_id = ?",
            payload.nodeId,
            th.threadId,
          )
          .toArray()[0];

        const itemCount = th.itemCount ?? 0;
        const updatedAt = th.updatedAt ?? now;
        const progressed =
          !prev ||
          itemCount !== prev.item_count ||
          th.status !== prev.status ||
          updatedAt !== prev.updated_at;
        const lastProgressAt = progressed ? now : prev.last_progress_at;
        const isActive = th.status === "running" || th.status === "starting";
        const stalled =
          isActive && !th.settled && nowMs - Date.parse(lastProgressAt) > STALL_THREAD_MS;
        // Clear any prior dismissal automatically once a thread runs again
        const dismissedAt = isActive ? null : (prev?.dismissed_at ?? null);

        this.sql.exec(
          `INSERT INTO threads (
            node_id, thread_id, project_id, project_title, project_path, title, link,
            status, settled, snoozed, item_count, updated_at, last_progress_at, stalled, dismissed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(node_id, thread_id) DO UPDATE SET
            project_id = excluded.project_id,
            project_title = excluded.project_title,
            project_path = excluded.project_path,
            title = excluded.title,
            link = excluded.link,
            status = excluded.status,
            settled = excluded.settled,
            snoozed = excluded.snoozed,
            item_count = excluded.item_count,
            updated_at = excluded.updated_at,
            last_progress_at = excluded.last_progress_at,
            stalled = excluded.stalled,
            dismissed_at = excluded.dismissed_at`,
          payload.nodeId,
          th.threadId,
          th.projectId ?? null,
          th.projectTitle ?? null,
          th.projectPath ?? null,
          th.title || "(untitled)",
          th.link ?? null,
          th.status,
          th.settled ? 1 : 0,
          th.snoozed ? 1 : 0,
          itemCount,
          updatedAt,
          lastProgressAt,
          stalled ? 1 : 0,
          dismissedAt,
        );

        // Suppress self-wakeup events for the Helm Home thread itself
        if (helmThreadId && th.threadId === helmThreadId) {
          continue;
        }

        // Emit webhook-worthy events only on real transitions (never on initial baseline!)
        if (prev && prev.status !== th.status) {
          const linkTag = th.link ? ` (${th.link})` : "";
          if (
            (prev.status === "running" || prev.status === "starting" || prev.status === "queued") &&
            (th.status === "completed" || th.status === "idle")
          ) {
            newEvents.push(
              this.recordEvent(
                "thread_completed",
                payload.nodeId,
                th.threadId,
                `[${payload.name}] "${th.title}" completed${linkTag}`,
                { status: th.status, link: th.link, projectTitle: th.projectTitle },
              ),
            );
          } else if (th.status === "failed" || th.status === "interrupted") {
            newEvents.push(
              this.recordEvent(
                "thread_failed",
                payload.nodeId,
                th.threadId,
                `[${payload.name}] "${th.title}" ${th.status}${linkTag}`,
                { status: th.status, link: th.link, projectTitle: th.projectTitle },
              ),
            );
          } else if (th.status === "waiting") {
            newEvents.push(
              this.recordEvent(
                "thread_needs_input",
                payload.nodeId,
                th.threadId,
                `[${payload.name}] "${th.title}" is waiting on input/approval${linkTag}`,
                { status: th.status, link: th.link, projectTitle: th.projectTitle },
              ),
            );
          }
        } else if (prev && !prev.stalled && stalled) {
          newEvents.push(
            this.recordEvent(
              "thread_stalled",
              payload.nodeId,
              th.threadId,
              `[${payload.name}] "${th.title}" appears stalled (no progress for 20m)`,
              { link: th.link, lastProgressAt },
            ),
          );
        }
      }
    }

    await this.maybePushWebhook(newEvents);

    const { standDown, reason } = this.isStandDown();
    const pendingCommands = standDown ? [] : this.claimPendingCommands(payload.nodeId);

    return this.json({
      ok: true,
      serverTime: now,
      standDown,
      standDownReason: reason,
      eventsRecorded: newEvents.length,
      pendingCommands,
    });
  }

  private getOverview(): OverviewResponse {
    const nodes = this.listNodes();
    const threads = this.listThreads();
    const ideas = this.listIdeas();
    const recentEvents = this.listEvents(20);
    const { standDown, reason } = this.isStandDown();

    const activeStatuses = new Set(["running", "starting", "queued", "preparing"]);
    const recentFailCutoffMs = Date.now() - 24 * 60 * 60_000;

    const inFlight = threads.filter((t) => !t.settled && activeStatuses.has(t.status));
    const needsAttention = threads.filter((t) => {
      if (t.settled || t.snoozed || t.dismissedAt) return false;
      if (t.status === "waiting" || t.stalled) return true;
      if (t.status === "failed" || t.status === "interrupted") {
        const updatedMs = Date.parse(t.updatedAt);
        return Number.isFinite(updatedMs) && updatedMs >= recentFailCutoffMs;
      }
      return false;
    });
    const pendingCommandsRow = this.sql
      .exec<{ c: number }>("SELECT COUNT(*) AS c FROM commands WHERE status = 'pending'")
      .toArray()[0];

    return {
      generatedAt: nowIso(),
      standDown,
      standDownReason: reason,
      counts: {
        nodesOnline: nodes.filter((n) => n.status === "online").length,
        nodesTotal: nodes.length,
        threadsActive: inFlight.length,
        needsAttention: needsAttention.length,
        ideasInbox: ideas.filter((i) => i.status === "inbox").length,
        pendingCommands: pendingCommandsRow?.c ?? 0,
      },
      nodes,
      needsAttention,
      inFlight,
      ideas,
      recentEvents,
      rebalanceSuggestions: buildRebalanceSuggestions(nodes, threads),
    };
  }

  private dismissThreads(body: Record<string, unknown>): Record<string, unknown> {
    const now = nowIso();
    const allFailed = body.allFailed === true;
    const threadId = typeof body.threadId === "string" ? body.threadId.trim() : "";
    const nodeId = typeof body.nodeId === "string" && body.nodeId.trim() ? body.nodeId.trim() : null;

    if (!allFailed && !threadId) {
      throw new Error("Provide threadId or allFailed: true");
    }

    if (allFailed) {
      const countRow = this.sql
        .exec<{ c: number }>(
          "SELECT COUNT(*) AS c FROM threads WHERE status IN ('failed', 'interrupted') AND dismissed_at IS NULL",
        )
        .toArray()[0];
      this.sql.exec(
        "UPDATE threads SET dismissed_at = ? WHERE status IN ('failed', 'interrupted') AND dismissed_at IS NULL",
        now,
      );
      return {
        ok: true,
        mode: "allFailed",
        dismissedCount: countRow?.c ?? 0,
        dismissedAt: now,
      };
    }

    const countRow = nodeId
      ? this.sql
          .exec<{ c: number }>(
            "SELECT COUNT(*) AS c FROM threads WHERE node_id = ? AND thread_id = ? AND dismissed_at IS NULL",
            nodeId,
            threadId,
          )
          .toArray()[0]
      : this.sql
          .exec<{ c: number }>(
            "SELECT COUNT(*) AS c FROM threads WHERE thread_id = ? AND dismissed_at IS NULL",
            threadId,
          )
          .toArray()[0];

    if (nodeId) {
      this.sql.exec(
        "UPDATE threads SET dismissed_at = ? WHERE node_id = ? AND thread_id = ?",
        now,
        nodeId,
        threadId,
      );
    } else {
      this.sql.exec(
        "UPDATE threads SET dismissed_at = ? WHERE thread_id = ?",
        now,
        threadId,
      );
    }

    return {
      ok: true,
      mode: "thread",
      threadId,
      nodeId,
      dismissedCount: countRow?.c ?? 0,
      dismissedAt: now,
    };
  }

  private createIdea(body: Record<string, unknown>): IdeaRecord {
    const title = String(body.title ?? "").trim();
    if (!title) throw new Error("title is required");
    const now = nowIso();
    const id = shortId("idea");
    const notes = String(body.notes ?? "");
    const priority = (["P0", "P1", "P2", "P3"].includes(String(body.priority))
      ? String(body.priority)
      : "P2") as Priority;
    const workload = inferWorkload({
      title,
      description: notes,
      workload: body.workload as RouteRequest["workload"],
    });
    const visibility = (["business", "public", "private-spot"].includes(String(body.visibility))
      ? String(body.visibility)
      : "business") as TaskVisibility;
    const project = typeof body.project === "string" && body.project.trim() ? body.project.trim() : null;

    this.sql.exec(
      `INSERT INTO ideas (
        id, title, notes, priority, status, workload, visibility, project, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'inbox', ?, ?, ?, ?, ?)`,
      id,
      title,
      notes,
      priority,
      workload,
      visibility,
      project,
      now,
      now,
    );

    return {
      id,
      title,
      notes,
      priority,
      status: "inbox",
      workload,
      visibility,
      project,
      assignedNode: null,
      threadId: null,
      threadLink: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  private updateIdea(id: string, body: Record<string, unknown>): IdeaRecord {
    const existing = this.listIdeas().find((i) => i.id === id);
    if (!existing) throw new Error(`Idea not found: ${id}`);

    const updated: IdeaRecord = {
      ...existing,
      title: typeof body.title === "string" && body.title.trim() ? body.title.trim() : existing.title,
      notes: typeof body.notes === "string" ? body.notes : existing.notes,
      priority: (["P0", "P1", "P2", "P3"].includes(String(body.priority))
        ? String(body.priority)
        : existing.priority) as Priority,
      status: (["inbox", "planned", "dispatched", "done", "parked"].includes(String(body.status))
        ? String(body.status)
        : existing.status) as IdeaRecord["status"],
      assignedNode:
        typeof body.assignedNode === "string" ? body.assignedNode : existing.assignedNode,
      threadId: typeof body.threadId === "string" ? body.threadId : existing.threadId,
      threadLink: typeof body.threadLink === "string" ? body.threadLink : existing.threadLink,
      updatedAt: nowIso(),
    };

    this.sql.exec(
      `UPDATE ideas SET
        title = ?, notes = ?, priority = ?, status = ?, assigned_node = ?,
        thread_id = ?, thread_link = ?, updated_at = ?
      WHERE id = ?`,
      updated.title,
      updated.notes,
      updated.priority,
      updated.status,
      updated.assignedNode,
      updated.threadId,
      updated.threadLink,
      updated.updatedAt,
      id,
    );

    return updated;
  }

  private dispatchTask(body: Record<string, unknown>): Record<string, unknown> {
    const { standDown, reason: sdReason } = this.isStandDown();
    if (standDown) {
      throw new Error(`Flagship is in stand-down (${sdReason ?? "paused"}). Resume before dispatching.`);
    }

    const title = String(body.title ?? "").trim();
    const prompt = String(body.prompt ?? title).trim();
    if (!title) throw new Error("title is required");

    const decision = routeTask(this.listNodes(), {
      title,
      description: prompt,
      workload: body.workload as RouteRequest["workload"],
      project: typeof body.project === "string" ? body.project : undefined,
      preferredNode: typeof body.preferredNode === "string" ? body.preferredNode : undefined,
      requireDevice: body.requireDevice as RouteRequest["requireDevice"],
      visibility: body.visibility as RouteRequest["visibility"],
      allowFallback: body.allowFallback !== false,
    });

    if (!decision.selectedNode) {
      return { ok: false, decision };
    }

    const mode = body.mode === "plan" ? "plan" : "lookout";
    if (mode === "plan") {
      return {
        ok: true,
        mode: "plan",
        decision,
        targetEnvironmentId: decision.selectedNode.environmentId,
        targetProject: decision.matchedProject,
      };
    }

    const cmdId = shortId("cmd");
    const now = nowIso();
    const payload = {
      title,
      prompt,
      project: decision.matchedProject?.path ?? (typeof body.project === "string" ? body.project : "."),
      worktree: typeof body.worktree === "string" ? body.worktree : undefined,
      branch: typeof body.branch === "string" ? body.branch : undefined,
      provider: typeof body.provider === "string" ? body.provider : undefined,
      model: typeof body.model === "string" ? body.model : undefined,
      ideaId: typeof body.ideaId === "string" ? body.ideaId : undefined,
    };

    this.sql.exec(
      "INSERT INTO commands (id, node_id, kind, payload_json, status, created_at, updated_at) VALUES (?, ?, 'launch_thread', ?, 'pending', ?, ?)",
      cmdId,
      decision.selectedNode.nodeId,
      JSON.stringify(payload),
      now,
      now,
    );

    if (typeof body.ideaId === "string" && body.ideaId) {
      try {
        this.updateIdea(body.ideaId, {
          status: "dispatched",
          assignedNode: decision.selectedNode.nodeId,
        });
      } catch {
        // Ignore unknown ideaId
      }
    }

    this.recordEvent(
      "task_dispatched",
      decision.selectedNode.nodeId,
      null,
      `Dispatched "${title}" (${decision.inferredWorkload}) to ${decision.selectedNode.name}`,
      { commandId: cmdId, workload: decision.inferredWorkload },
    );

    return {
      ok: true,
      mode: "lookout",
      commandId: cmdId,
      decision,
    };
  }

  private queueSend(body: Record<string, unknown>): Record<string, unknown> {
    const nodeId = String(body.nodeId ?? "").trim();
    const threadId = String(body.threadId ?? "").trim();
    const message = String(body.message ?? "").trim();
    if (!nodeId || !threadId || !message) {
      throw new Error("nodeId, threadId, and message are required");
    }
    const cmdId = shortId("cmd");
    const now = nowIso();
    this.sql.exec(
      "INSERT INTO commands (id, node_id, kind, payload_json, status, created_at, updated_at) VALUES (?, ?, 'send_message', ?, 'pending', ?, ?)",
      cmdId,
      nodeId,
      JSON.stringify({ threadId, message }),
      now,
      now,
    );
    return { ok: true, commandId: cmdId, nodeId, threadId };
  }

  private async handleCommandResult(
    id: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const rows = this.sql
      .exec<{ node_id: string; kind: string; payload_json: string }>(
        "SELECT node_id, kind, payload_json FROM commands WHERE id = ?",
        id,
      )
      .toArray();
    if (rows.length === 0) {
      return this.json({ error: `Command not found: ${id}` }, 404);
    }

    const status = body.ok === false ? "failed" : "done";
    const now = nowIso();
    this.sql.exec(
      "UPDATE commands SET status = ?, result_json = ?, updated_at = ? WHERE id = ?",
      status,
      JSON.stringify(body),
      now,
      id,
    );
    this.sql.exec(
      "DELETE FROM commands WHERE status IN ('done', 'failed') AND id NOT IN (SELECT id FROM commands WHERE status IN ('done', 'failed') ORDER BY updated_at DESC LIMIT ?)",
      MAX_FINISHED_COMMANDS,
    );

    const payload = JSON.parse(rows[0].payload_json || "{}");
    const threadId = typeof body.threadId === "string" ? body.threadId : null;
    const threadLink = typeof body.threadLink === "string" ? body.threadLink : null;

    if (payload.ideaId && (threadId || threadLink)) {
      try {
        this.updateIdea(String(payload.ideaId), {
          threadId: threadId ?? undefined,
          threadLink: threadLink ?? undefined,
        });
      } catch {
        // ignore
      }
    }

    const ev = this.recordEvent(
      status === "done" ? "command_done" : "command_failed",
      rows[0].node_id,
      threadId,
      status === "done"
        ? `[${rows[0].node_id}] Launched "${payload.title ?? rows[0].kind}"${threadLink ? ` (${threadLink})` : ""}`
        : `[${rows[0].node_id}] Command ${rows[0].kind} failed: ${String(body.error ?? "unknown error")}`,
      { commandId: id, ...body },
    );

    if (status === "failed") {
      await this.maybePushWebhook([ev]);
    }

    return this.json({ ok: true, commandId: id, status });
  }

  private async runMcpTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "flagship_overview":
        return this.getOverview();
      case "flagship_route":
        return routeTask(this.listNodes(), args as unknown as RouteRequest);
      case "flagship_idea_add":
        return this.createIdea(args);
      case "flagship_idea_update":
        return this.updateIdea(String(args.id ?? ""), args);
      case "flagship_dispatch":
        return this.dispatchTask(args);
      case "flagship_send":
        return this.queueSend(args);
      case "flagship_stand_down": {
        const reason =
          typeof args.reason === "string" && args.reason.trim()
            ? args.reason.trim()
            : "Paused by operator";
        this.setControl("stand_down", "true");
        this.setControl("stand_down_reason", reason);
        this.recordEvent("stand_down", null, null, `Flagship standing down: ${reason}`);
        return { ok: true, standDown: true, reason };
      }
      case "flagship_resume": {
        this.setControl("stand_down", "false");
        this.setControl("stand_down_reason", "");
        this.recordEvent("resume", null, null, "Flagship resumed.");
        return { ok: true, standDown: false };
      }
      case "flagship_dismiss":
        return this.dismissThreads(args);
      case "flagship_events":
        return { events: this.listEvents(Number(args.limit ?? 25)) };
      default:
        throw new Error(`Unsupported MCP tool: ${name}`);
    }
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureSchema();
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      if (path === "/api/nodes/heartbeat" && method === "POST") {
        return await this.handleHeartbeat((await request.json()) as HeartbeatPayload);
      }

      if (path === "/api/nodes" && method === "GET") {
        return this.json({ nodes: this.listNodes() });
      }

      if (path === "/api/overview" && method === "GET") {
        return this.json(this.getOverview());
      }

      if (path === "/api/route" && method === "POST") {
        const body = (await request.json()) as RouteRequest;
        return this.json(routeTask(this.listNodes(), body));
      }

      if (path === "/api/ideas" && method === "GET") {
        return this.json({ ideas: this.listIdeas() });
      }

      if (path === "/api/ideas" && method === "POST") {
        const body = (await request.json()) as Record<string, unknown>;
        return this.json(this.createIdea(body), 201);
      }

      const ideaMatch = path.match(/^\/api\/ideas\/([^/]+)$/);
      if (ideaMatch && method === "PATCH") {
        const body = (await request.json()) as Record<string, unknown>;
        return this.json(this.updateIdea(decodeURIComponent(ideaMatch[1]), body));
      }

      if (path === "/api/dispatch" && method === "POST") {
        const body = (await request.json()) as Record<string, unknown>;
        return this.json(this.dispatchTask(body));
      }

      if (path === "/api/threads/send" && method === "POST") {
        const body = (await request.json()) as Record<string, unknown>;
        return this.json(this.queueSend(body));
      }

      if (path === "/api/threads/dismiss" && method === "POST") {
        const body = (await request.json()) as Record<string, unknown>;
        return this.json(this.dismissThreads(body));
      }

      const cmdMatch = path.match(/^\/api\/commands\/([^/]+)\/result$/);
      if (cmdMatch && method === "POST") {
        const body = (await request.json()) as Record<string, unknown>;
        return await this.handleCommandResult(decodeURIComponent(cmdMatch[1]), body);
      }

      if (path === "/api/commands" && method === "GET") {
        const rows = this.sql
          .exec("SELECT * FROM commands ORDER BY created_at DESC LIMIT 50")
          .toArray();
        return this.json({ commands: rows });
      }

      if (path === "/api/events" && method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? "25");
        return this.json({ events: this.listEvents(limit) });
      }

      if (path === "/api/control/stand-down" && method === "POST") {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const reason =
          typeof body.reason === "string" && body.reason.trim()
            ? body.reason.trim()
            : "Paused by operator";
        this.setControl("stand_down", "true");
        this.setControl("stand_down_reason", reason);
        this.recordEvent("stand_down", null, null, `Flagship standing down: ${reason}`);
        return this.json({ ok: true, standDown: true, reason });
      }

      if (path === "/api/control/resume" && method === "POST") {
        this.setControl("stand_down", "false");
        this.setControl("stand_down_reason", "");
        this.recordEvent("resume", null, null, "Flagship resumed.");
        return this.json({ ok: true, standDown: false });
      }

      if (path === "/api/control/webhook" && method === "POST") {
        const body = (await request.json()) as Record<string, unknown>;
        if ("url" in body) {
          const webhookUrl = validateWebhookUrl(typeof body.url === "string" ? body.url : "");
          this.setControl("helm_webhook_url", webhookUrl);
        }
        if ("secret" in body) {
          const webhookSecret = typeof body.secret === "string" ? body.secret.trim() : "";
          this.setControl("helm_webhook_secret", webhookSecret);
        }
        if ("threadId" in body) {
          const threadId = typeof body.threadId === "string" ? body.threadId.trim() : "";
          this.setControl("helm_thread_id", threadId);
        }
        const currentUrl = this.getControl("helm_webhook_url") ?? "";
        const currentSecret = this.getControl("helm_webhook_secret") ?? "";
        const currentHelmThreadId = this.getControl("helm_thread_id")?.trim() || null;
        return this.json({
          ok: true,
          configured: Boolean(currentUrl),
          hasSecret: Boolean(currentSecret),
          helmThreadId: currentHelmThreadId,
        });
      }

      if (path === "/api/control/webhook/test" && method === "POST") {
        const urlVal = this.getControl("helm_webhook_url");
        if (!urlVal) return this.json({ ok: false, error: "No Helm webhook configured" }, 400);
        const testEv = this.recordEvent("webhook_test", null, null, "Flagship test wakeup to Helm.");
        const res = await this.webhookPusher(urlVal, this.getControl("helm_webhook_secret"), [testEv]);
        return this.json({ ...res, eventId: testEv.id }, res.ok ? 200 : 502);
      }

      if (path === "/mcp" && method === "POST") {
        const body = await request.json().catch(() => null);
        const res = await handleMcpRequest(body, (n, a) => this.runMcpTool(n, a), this.version);
        if (res.body === null) {
          return new Response(null, { status: 202 });
        }
        return this.json(res.body, res.status);
      }

      return this.json({ error: `Not found: ${method} ${path}` }, 404);
    } catch (err) {
      return this.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  }
}
