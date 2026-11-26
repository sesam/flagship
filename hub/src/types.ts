export type NodeRole = "vm" | "workstation" | "tiny" | "device-host";

export type WorkloadKind =
  | "auto"
  | "small"
  | "slow"
  | "research"
  | "scaffolding"
  | "heavy"
  | "build"
  | "mobile";

export type TaskVisibility = "business" | "public" | "private-spot";

export type Priority = "P0" | "P1" | "P2" | "P3";

export type AlertStatus = "open" | "working" | "resolved" | "false_positive" | "wontfix";

export interface AlertRecord {
  alertKey: string;
  repo: string | null;
  channelId: string | null;
  messageId: string | null;
  source: string;
  severity: string;
  status: AlertStatus;
  summary: string;
  text: string;
  threadId: string | null;
  threadLink: string | null;
  silentFirst: boolean;
  hitCount: number;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DiscordReactionResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface MobileDevice {
  id: string;
  platform: "android" | "ios";
  name: string;
  state: string;
}

export interface NodeProject {
  id?: string;
  title: string;
  path: string;
  repo?: string;
}

export interface NodeTelemetry {
  ramTotalMb: number;
  ramFreeMb: number;
  ramUsedPct: number;
  cpuCores: number;
  load1m: number;
  diskFreeGb: number;
  activeThreads: number;
  maxSlots: number;
  devices?: MobileDevice[];
}

export interface ThreadSnapshot {
  threadId: string;
  projectId?: string;
  projectTitle?: string;
  projectPath?: string;
  title: string;
  link?: string;
  status: string;
  settled?: boolean;
  snoozed?: boolean;
  itemCount?: number;
  updatedAt?: string;
  parentThreadId?: string | null;
}

export interface HeartbeatPayload {
  nodeId: string;
  name: string;
  role: NodeRole;
  environmentId?: string;
  owner?: string;
  platform?: string;
  arch?: string;
  capabilities?: string[];
  projects?: NodeProject[];
  telemetry: NodeTelemetry;
  threads?: ThreadSnapshot[];
  /** Optional quota policy for future multi-user Flotilla mode */
  quota?: {
    businessMaxSharePct?: number;
    spotMinFreeRamPct?: number;
  };
}

export interface NodeRecord {
  nodeId: string;
  name: string;
  role: NodeRole;
  environmentId: string | null;
  owner: string;
  platform: string;
  arch: string;
  capabilities: string[];
  projects: NodeProject[];
  telemetry: NodeTelemetry;
  quota: {
    businessMaxSharePct: number;
    spotMinFreeRamPct: number;
  };
  status: "online" | "stale" | "offline";
  lastSeenAt: string;
}

export interface StoredThread {
  nodeId: string;
  threadId: string;
  projectId: string | null;
  projectTitle: string | null;
  projectPath: string | null;
  title: string;
  link: string | null;
  status: string;
  settled: boolean;
  snoozed: boolean;
  itemCount: number;
  updatedAt: string;
  lastProgressAt: string;
  stalled: boolean;
  dismissedAt?: string | null;
}

export interface IdeaRecord {
  id: string;
  title: string;
  notes: string;
  priority: Priority;
  status: "inbox" | "planned" | "dispatched" | "done" | "parked";
  workload: Exclude<WorkloadKind, "auto">;
  visibility: TaskVisibility;
  project: string | null;
  assignedNode: string | null;
  threadId: string | null;
  threadLink: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommandRecord {
  id: string;
  nodeId: string;
  kind: "launch_thread" | "send_message";
  payload: Record<string, unknown>;
  status: "pending" | "claimed" | "done" | "failed";
  result: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface FleetEvent {
  id: number;
  kind: string;
  nodeId: string | null;
  threadId: string | null;
  summary: string;
  payload: Record<string, unknown>;
  delivered: boolean;
  createdAt: string;
}

export interface RouteRequest {
  title: string;
  description?: string;
  workload?: WorkloadKind;
  project?: string;
  preferredNode?: string;
  requireDevice?: "android" | "ios";
  visibility?: TaskVisibility;
  requester?: string;
  allowFallback?: boolean;
}

export interface NodeScore {
  nodeId: string;
  name: string;
  role: NodeRole;
  eligible: boolean;
  score: number;
  reasons: string[];
}

export interface RouteDecision {
  inferredWorkload: Exclude<WorkloadKind, "auto">;
  selectedNode: NodeRecord | null;
  matchedProject: NodeProject | null;
  fallbackUsed: boolean;
  reason: string;
  scores: NodeScore[];
}

export interface RebalanceSuggestion {
  kind: "stalled_thread" | "overloaded_node" | "workload_mismatch" | "offline_node";
  severity: "info" | "warn";
  nodeId: string;
  threadId?: string;
  message: string;
}

export interface OverviewResponse {
  generatedAt: string;
  standDown: boolean;
  standDownReason: string | null;
  counts: {
    nodesOnline: number;
    nodesTotal: number;
    threadsActive: number;
    needsAttention: number;
    ideasInbox: number;
    pendingCommands: number;
    openAlerts: number;
  };
  nodes: NodeRecord[];
  needsAttention: StoredThread[];
  inFlight: StoredThread[];
  ideas: IdeaRecord[];
  openAlerts: AlertRecord[];
  recentEvents: FleetEvent[];
  rebalanceSuggestions: RebalanceSuggestion[];
}

export interface Env {
  FLAGSHIP_HUB: DurableObjectNamespace;
  FLAGSHIP_TOKEN?: string;
  FLAGSHIP_VERSION?: string;
  CORS_ORIGIN?: string;
  NOTIFY_DISCORD_URL?: string;
  NOTIFY_DISCORD_TOKEN?: string;
  NOTIFY_DISCORD_REPO_PATH?: string;
}
