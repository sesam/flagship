import { describe, expect, it } from "vitest";
import { handleMcpRequest } from "../src/mcp";
import { buildRebalanceSuggestions, inferWorkload, routeTask } from "../src/router";
import type { NodeRecord, StoredThread } from "../src/types";

const cloudVm: NodeRecord = {
  nodeId: "cloud-vm",
  name: "Cloud VM",
  role: "vm",
  environmentId: "env-vm-example-001",
  owner: "captain",
  platform: "linux",
  arch: "x64",
  capabilities: ["small", "slow", "research", "scaffolding"],
  projects: [{ title: "web-app", path: "/srv/projects/web-app" }],
  telemetry: {
    ramTotalMb: 16000,
    ramFreeMb: 8200,
    ramUsedPct: 48,
    cpuCores: 4,
    load1m: 0.4,
    diskFreeGb: 34,
    activeThreads: 1,
    maxSlots: 6,
    devices: [],
  },
  quota: { businessMaxSharePct: 90, spotMinFreeRamPct: 50 },
  status: "online",
  lastSeenAt: new Date().toISOString(),
};

const workstation: NodeRecord = {
  nodeId: "dev-laptop",
  name: "Dev Laptop",
  role: "workstation",
  environmentId: "env-laptop-example-002",
  owner: "captain",
  platform: "darwin",
  arch: "arm64",
  capabilities: ["heavy", "build", "cpu", "memory", "interactive"],
  projects: [{ title: "web-app", path: "/Users/dev/projects/web-app" }],
  telemetry: {
    ramTotalMb: 16384,
    ramFreeMb: 9000,
    ramUsedPct: 45,
    cpuCores: 10,
    load1m: 1.2,
    diskFreeGb: 120,
    activeThreads: 0,
    maxSlots: 4,
    devices: [{ id: "emulator-5554", platform: "android", name: "Pixel 7", state: "device" }],
  },
  quota: { businessMaxSharePct: 90, spotMinFreeRamPct: 50 },
  status: "online",
  lastSeenAt: new Date().toISOString(),
};

const rpi: NodeRecord = {
  nodeId: "office-rpi3",
  name: "Office RPi 3+",
  role: "tiny",
  environmentId: null,
  owner: "captain",
  platform: "linux",
  arch: "armv7l",
  capabilities: ["tiny", "watch"],
  projects: [],
  telemetry: {
    ramTotalMb: 1024,
    ramFreeMb: 520,
    ramUsedPct: 49,
    cpuCores: 4,
    load1m: 0.1,
    diskFreeGb: 12,
    activeThreads: 0,
    maxSlots: 2,
    devices: [],
  },
  quota: { businessMaxSharePct: 90, spotMinFreeRamPct: 50 },
  status: "online",
  lastSeenAt: new Date().toISOString(),
};

describe("inferWorkload", () => {
  it("classifies research, scaffolding, heavy, and mobile tasks", () => {
    expect(inferWorkload({ title: "Research pricing tiers for EU markets" })).toBe("research");
    expect(inferWorkload({ title: "Scaffold a new Cloudflare worker starter" })).toBe("scaffolding");
    expect(inferWorkload({ title: "Run full Vite + Three.js 3D build & Playwright suite" })).toBe("heavy");
    expect(inferWorkload({ title: "Test Android APK layout on tablet" })).toBe("mobile");
    expect(inferWorkload({ title: "Rename two helper variables" })).toBe("small");
  });
});

describe("routeTask", () => {
  it("routes small, research, and scaffolding work to the cloud VM", () => {
    const res1 = routeTask([cloudVm, workstation, rpi], {
      title: "Research competitor pricing models",
    });
    expect(res1.selectedNode?.nodeId).toBe("cloud-vm");
    expect(res1.fallbackUsed).toBe(false);

    const res2 = routeTask([cloudVm, workstation, rpi], {
      title: "Scaffold new microservice skeleton",
    });
    expect(res2.selectedNode?.nodeId).toBe("cloud-vm");
  });

  it("routes CPU/memory heavy builds to the workstation", () => {
    const res = routeTask([cloudVm, workstation, rpi], {
      title: "Build and profile Three.js frontend bundle",
      project: "web-app",
    });
    expect(res.selectedNode?.nodeId).toBe("dev-laptop");
    expect(res.matchedProject?.path).toBe("/Users/dev/projects/web-app");
    expect(res.fallbackUsed).toBe(false);
  });

  it("never routes heavy work to 1 GB RPi 3+", () => {
    const res = routeTask([rpi], {
      title: "Compile monorepo and run Playwright browser tests",
    });
    expect(res.selectedNode).toBeNull();
  });

  it("falls back to the cloud VM when workstation is offline", () => {
    const offlineLaptop: NodeRecord = { ...workstation, status: "offline" };
    const res = routeTask([cloudVm, offlineLaptop, rpi], {
      title: "Build frontend bundle",
      project: "web-app",
    });
    expect(res.selectedNode?.nodeId).toBe("cloud-vm");
    expect(res.fallbackUsed).toBe(true);
  });

  it("routes mobile test tasks to node with attached Android device", () => {
    const res = routeTask([cloudVm, workstation, rpi], {
      title: "Verify Android responsive layout",
      requireDevice: "android",
    });
    expect(res.selectedNode?.nodeId).toBe("dev-laptop");
  });

  it("shifts research tasks off a pegged VM to a healthy workstation", () => {
    const peggedVm: NodeRecord = {
      ...cloudVm,
      telemetry: { ...cloudVm.telemetry, load1m: 10.8, cpuCores: 4 },
    };
    const healthyLaptop: NodeRecord = {
      ...workstation,
      telemetry: { ...workstation.telemetry, load1m: 4.5, cpuCores: 10 },
    };
    const res = routeTask([peggedVm, healthyLaptop], {
      title: "Research billing tiers",
      workload: "research",
    });
    expect(res.selectedNode?.nodeId).toBe("dev-laptop");
    expect(res.fallbackUsed).toBe(true);
    const vmScore = res.scores.find((s) => s.nodeId === "cloud-vm");
    expect(vmScore?.reasons.some((r) => r.includes("-85 CPU pegged"))).toBe(true);
  });

  it("tips research tasks off a saturated VM toward a cool workstation", () => {
    const saturatedVm: NodeRecord = {
      ...cloudVm,
      telemetry: { ...cloudVm.telemetry, load1m: 6.4, cpuCores: 4 },
    };
    const coolLaptop: NodeRecord = {
      ...workstation,
      telemetry: { ...workstation.telemetry, load1m: 1.2, cpuCores: 10 },
    };
    const res = routeTask([saturatedVm, coolLaptop], {
      title: "Research billing flow",
      workload: "research",
    });
    expect(res.selectedNode?.nodeId).toBe("dev-laptop");
    const vmScore = res.scores.find((s) => s.nodeId === "cloud-vm");
    expect(vmScore?.reasons.some((r) => r.includes("-55 CPU saturated"))).toBe(true);
  });

  it("enforces Flotilla spot-only free-RAM floor for non-owner private jobs", () => {
    const busyLaptop: NodeRecord = {
      ...workstation,
      telemetry: { ...workstation.telemetry, ramFreeMb: 4000, ramUsedPct: 75 },
    };
    const res = routeTask([busyLaptop], {
      title: "Private heavy build",
      workload: "heavy",
      visibility: "private-spot",
      requester: "friend-alice",
    });
    expect(res.selectedNode).toBeNull();
  });
});

describe("buildRebalanceSuggestions", () => {
  it("flags memory-tight nodes and stalled threads", () => {
    const tightVm: NodeRecord = {
      ...cloudVm,
      telemetry: { ...cloudVm.telemetry, ramFreeMb: 1200, ramUsedPct: 92 },
    };
    const stalledThread: StoredThread = {
      nodeId: "cloud-vm",
      threadId: "t1",
      projectId: "p1",
      projectTitle: "web-app",
      projectPath: "/srv/projects/web-app",
      title: "Stuck migration",
      link: null,
      status: "running",
      settled: false,
      snoozed: false,
      itemCount: 4,
      updatedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      lastProgressAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      stalled: true,
    };
    const suggestions = buildRebalanceSuggestions([tightVm, workstation], [stalledThread]);
    expect(suggestions.some((s) => s.kind === "overloaded_node")).toBe(true);
    expect(suggestions.some((s) => s.kind === "stalled_thread")).toBe(true);
  });

  it("emits a warn overloaded_node suggestion when CPU loadPerCore >= 1.50", () => {
    const saturatedVm: NodeRecord = {
      ...cloudVm,
      telemetry: { ...cloudVm.telemetry, load1m: 6.8, cpuCores: 4 },
    };
    const suggestions = buildRebalanceSuggestions([saturatedVm, workstation], []);
    const cpuWarn = suggestions.find(
      (s) => s.kind === "overloaded_node" && s.severity === "warn" && s.nodeId === "cloud-vm",
    );
    expect(cpuWarn).toBeDefined();
    expect(cpuWarn?.message).toContain("CPU is saturated");
    expect(cpuWarn?.message).toContain("Dev Laptop");
  });
});

describe("MCP endpoint", () => {
  it("answers initialize, tools/list, and tools/call", async () => {
    const init = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize" }, async () => ({}), "0.1.0");
    expect((init.body as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("flagship-hub");

    const list = await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }, async () => ({}), "0.1.0");
    const tools = (list.body as { result: { tools: Array<{ name: string }> } }).result.tools;
    expect(tools.some((t) => t.name === "flagship_overview")).toBe(true);
    expect(tools.some((t) => t.name === "flagship_dispatch")).toBe(true);
    expect(tools.some((t) => t.name === "flagship_dismiss")).toBe(true);

    const call = await handleMcpRequest(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "flagship_overview", arguments: {} } },
      async (name) => ({ called: name }),
      "0.1.0",
    );
    expect((call.body as { result: { structuredContent: { called: string } } }).result.structuredContent.called).toBe(
      "flagship_overview",
    );
  });
});
