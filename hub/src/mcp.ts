export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "flagship_overview",
    description:
      "Get the C-level executive overview of all Flagship nodes (cloud VMs, workstations, Raspberry Pis, mobile test devices), active threads, items waiting on human input, prioritized idea backlog, and rebalance suggestions.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "flagship_route",
    description:
      "Dry-run auto-distribution to choose the best machine for a task (small/slow/research/scaffolding -> VM, heavy/build/cpu/memory -> MacBook workstation, mobile -> attached device host).",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        workload: {
          type: "string",
          enum: ["auto", "small", "slow", "research", "scaffolding", "heavy", "build", "mobile"],
        },
        project: { type: "string" },
        preferredNode: { type: "string" },
        requireDevice: { type: "string", enum: ["android", "ios"] },
        visibility: { type: "string", enum: ["business", "public", "private-spot"] },
        allowFallback: { type: "boolean" },
      },
    },
  },
  {
    name: "flagship_idea_add",
    description:
      "Capture a raw idea or task into Flagship's prioritized inbox so Helm keeps its own chat lean.",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string" },
        notes: { type: "string" },
        priority: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
        workload: {
          type: "string",
          enum: ["auto", "small", "slow", "research", "scaffolding", "heavy", "build", "mobile"],
        },
        project: { type: "string" },
        visibility: { type: "string", enum: ["business", "public", "private-spot"] },
      },
    },
  },
  {
    name: "flagship_idea_update",
    description: "Update an idea's priority, status, notes, assigned node, or linked T3 thread.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        priority: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
        status: { type: "string", enum: ["inbox", "planned", "dispatched", "done", "parked"] },
        notes: { type: "string" },
        assignedNode: { type: "string" },
        threadId: { type: "string" },
        threadLink: { type: "string" },
      },
    },
  },
  {
    name: "flagship_dispatch",
    description:
      "Auto-route a task to the optimal machine and queue it for that node's Lookout to launch a T3 thread (or return a routing plan if mode='plan'). Refuses when Flagship is in stand-down.",
    inputSchema: {
      type: "object",
      required: ["title", "prompt"],
      properties: {
        title: { type: "string" },
        prompt: { type: "string" },
        project: { type: "string" },
        workload: {
          type: "string",
          enum: ["auto", "small", "slow", "research", "scaffolding", "heavy", "build", "mobile"],
        },
        preferredNode: { type: "string" },
        worktree: { type: "string" },
        branch: { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
        ideaId: { type: "string" },
        mode: { type: "string", enum: ["lookout", "plan"] },
      },
    },
  },
  {
    name: "flagship_send",
    description:
      "Queue a follow-up or steering message to an existing T3 thread on a specific node via Lookout.",
    inputSchema: {
      type: "object",
      required: ["nodeId", "threadId", "message"],
      properties: {
        nodeId: { type: "string" },
        threadId: { type: "string" },
        message: { type: "string" },
      },
    },
  },
  {
    name: "flagship_stand_down",
    description: "Hard pause Flagship: stops automatic webhook wakeups and new auto-dispatches.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string" },
      },
    },
  },
  {
    name: "flagship_resume",
    description: "Resume Flagship webhook wakeups and auto-dispatch after a stand-down.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "flagship_dismiss",
    description:
      "Dismiss a stale failed/interrupted or noisy attention thread (or all failed/interrupted threads) from Flagship's needsAttention list. Automatically clears if the thread runs again.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Specific thread ID to dismiss" },
        nodeId: { type: "string", description: "Optional node ID to scope threadId dismissal" },
        allFailed: { type: "boolean", description: "Dismiss all failed/interrupted threads" },
      },
    },
  },
  {
    name: "flagship_events",
    description: "Read recent state-change events across all nodes (thread completions, failures, stalls, needs-input).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "flagship_alerts",
    description:
      "List proactive Discord/ops alerts tracked by Flagship (defaults to open and working; pass status='all' for full history).",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "Filter by status: open, working, resolved, false_positive, wontfix, open,working (default), or all",
        },
      },
    },
  },
  {
    name: "flagship_alert_update",
    description:
      "Update a proactive alert's lifecycle status (working, resolved, false_positive, wontfix, open), attach a worker thread link or note, and automatically update the Discord reaction (⏳ / ✅ / 🤷 / 🚫).",
    inputSchema: {
      type: "object",
      required: ["alertKey", "status"],
      properties: {
        alertKey: { type: "string" },
        status: {
          type: "string",
          enum: ["open", "working", "resolved", "false_positive", "wontfix"],
        },
        threadId: { type: "string" },
        threadLink: { type: "string" },
        note: { type: "string" },
      },
    },
  },
];

export type McpToolHandler = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export async function handleMcpRequest(
  body: unknown,
  callTool: McpToolHandler,
  version: string,
): Promise<{ status: number; body: unknown }> {
  if (!body || typeof body !== "object") {
    return {
      status: 400,
      body: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid JSON-RPC request" } },
    };
  }

  const req = body as {
    jsonrpc?: string;
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown>;
  };
  const id = req.id ?? null;

  if (req.method === "initialize") {
    const requestedVersion =
      typeof req.params?.protocolVersion === "string"
        ? req.params.protocolVersion
        : "2025-03-26";
    return {
      status: 200,
      body: {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: requestedVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "flagship-hub", version },
        },
      },
    };
  }

  if (req.method === "notifications/initialized" || req.method === "ping") {
    return {
      status: 200,
      body: req.method === "ping" ? { jsonrpc: "2.0", id, result: {} } : null,
    };
  }

  if (req.method === "tools/list") {
    return {
      status: 200,
      body: {
        jsonrpc: "2.0",
        id,
        result: { tools: MCP_TOOLS },
      },
    };
  }

  if (req.method === "tools/call") {
    const name = typeof req.params?.name === "string" ? req.params.name : "";
    const args =
      req.params?.arguments && typeof req.params.arguments === "object"
        ? (req.params.arguments as Record<string, unknown>)
        : {};
    if (!MCP_TOOLS.some((t) => t.name === name)) {
      return {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `Unknown tool: ${name}` },
        },
      };
    }
    try {
      const data = await callTool(name, args);
      return {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
            structuredContent: data,
          },
        },
      };
    } catch (err) {
      return {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [
              {
                type: "text",
                text: err instanceof Error ? err.message : String(err),
              },
            ],
          },
        },
      };
    }
  }

  return {
    status: 200,
    body: {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${String(req.method)}` },
    },
  };
}
