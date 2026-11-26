import type {
  NodeProject,
  NodeRecord,
  NodeScore,
  RebalanceSuggestion,
  RouteDecision,
  RouteRequest,
  StoredThread,
  WorkloadKind,
} from "./types";

const HEAVY_KEYWORDS = [
  "build",
  "compile",
  "bundle",
  "webpack",
  "vite",
  "next",
  "playwright",
  "browser",
  "threejs",
  "three.js",
  "3d",
  "webgl",
  "docker",
  "xcode",
  "simulator",
  "emulator",
  "android studio",
  "heavy",
  "benchmark",
  "perf",
  "profile",
  "large refactor",
  "monorepo",
  "render",
  "video",
  "gpu",
  "cpu",
  "memory",
];

const MOBILE_KEYWORDS = [
  "android",
  "ios",
  "iphone",
  "ipad",
  "tablet",
  "apk",
  "ipa",
  "mobile test",
  "adb",
  "device test",
];

const SCAFFOLD_KEYWORDS = [
  "scaffold",
  "boilerplate",
  "init",
  "template",
  "skeleton",
  "setup",
  "bootstrap",
  "starter",
];

const RESEARCH_KEYWORDS = [
  "research",
  "investigate",
  "compare",
  "explore",
  "audit",
  "summarize",
  "read",
  "review",
  "docs",
  "documentation",
  "triage",
  "plan",
  "spec",
  "draft",
  "ideas",
  "check",
  "monitor",
  "watch",
];

export function inferWorkload(
  req: Pick<RouteRequest, "title" | "description" | "workload" | "requireDevice">,
): Exclude<WorkloadKind, "auto"> {
  if (req.workload && req.workload !== "auto") {
    return req.workload;
  }
  if (req.requireDevice) {
    return "mobile";
  }
  const text = `${req.title} ${req.description ?? ""}`.toLowerCase();
  if (MOBILE_KEYWORDS.some((kw) => text.includes(kw))) {
    return "mobile";
  }
  if (HEAVY_KEYWORDS.some((kw) => text.includes(kw))) {
    return "heavy";
  }
  if (SCAFFOLD_KEYWORDS.some((kw) => text.includes(kw))) {
    return "scaffolding";
  }
  if (RESEARCH_KEYWORDS.some((kw) => text.includes(kw))) {
    return "research";
  }
  return "small";
}

export function matchProject(node: NodeRecord, projectQuery?: string): NodeProject | null {
  if (!projectQuery) return null;
  const q = projectQuery.trim().toLowerCase();
  if (!q) return null;
  for (const p of node.projects) {
    if (
      (p.id && p.id.toLowerCase() === q) ||
      p.title.toLowerCase() === q ||
      p.path.toLowerCase() === q ||
      p.path.toLowerCase().endsWith(`/${q}`) ||
      (p.repo && p.repo.toLowerCase().includes(q))
    ) {
      return p;
    }
  }
  return null;
}

function hasDevice(node: NodeRecord, platform?: "android" | "ios"): boolean {
  const devices = node.telemetry.devices ?? [];
  if (!platform) return devices.length > 0;
  return devices.some((d) => d.platform === platform);
}

/**
 * Deterministic auto-distribution between machines:
 * - small / slow / research / scaffolding -> prefer VM to keep workstation free
 * - heavy / build -> prefer workstation with high CPU/RAM
 * - mobile -> require matching attached device (or device-host)
 * - spot / multi-user hooks -> respect owner & free-RAM spot floor
 */
export function routeTask(nodes: NodeRecord[], req: RouteRequest): RouteDecision {
  const workload = inferWorkload(req);
  const allowFallback = req.allowFallback !== false;
  const isVmPreferred =
    workload === "small" ||
    workload === "slow" ||
    workload === "research" ||
    workload === "scaffolding";
  const isHeavy = workload === "heavy" || workload === "build";
  const isMobile = workload === "mobile";

  const scores: NodeScore[] = [];

  for (const node of nodes) {
    const reasons: string[] = [];
    let eligible = true;
    let score = 50;

    if (node.status !== "online") {
      eligible = false;
      reasons.push(`node is ${node.status}`);
    }

    const t = node.telemetry;
    const maxSlots = Math.max(1, t.maxSlots || 4);
    const utilization = t.activeThreads / maxSlots;
    const freeRamPct = t.ramTotalMb > 0 ? (t.ramFreeMb / t.ramTotalMb) * 100 : 0;

    if (t.activeThreads >= maxSlots) {
      eligible = false;
      reasons.push(`slots full (${t.activeThreads}/${maxSlots})`);
    } else {
      const slotPenalty = Math.round(utilization * 20);
      if (slotPenalty > 0) {
        score -= slotPenalty;
        reasons.push(`-${slotPenalty} slot load (${t.activeThreads}/${maxSlots})`);
      }
    }

    // Future Flotilla spot-capacity guard for non-owner private jobs
    if (
      req.visibility === "private-spot" &&
      req.requester &&
      req.requester !== node.owner
    ) {
      const minFree = node.quota.spotMinFreeRamPct ?? 50;
      if (freeRamPct < minFree) {
        eligible = false;
        reasons.push(`spot floor blocked (${Math.round(freeRamPct)}% free < ${minFree}%)`);
      }
    }

    // Tiny nodes (e.g. 1 GB RPi 3+) should never take heavy/build workloads
    if (node.role === "tiny") {
      if (isHeavy) {
        eligible = false;
        reasons.push("tiny node disqualified for heavy/build workload");
      } else if (workload === "small" || workload === "slow") {
        score += 5;
        reasons.push("+5 tiny node can handle lightweight task");
      }
    }

    // RAM floor
    const minRamMb = isHeavy ? 3072 : node.role === "tiny" ? 200 : 768;
    if (t.ramFreeMb > 0 && t.ramFreeMb < minRamMb) {
      if (isHeavy && !allowFallback) {
        eligible = false;
        reasons.push(`free RAM ${t.ramFreeMb}MB < ${minRamMb}MB required`);
      } else {
        score -= 30;
        reasons.push(`-30 low free RAM (${t.ramFreeMb}MB)`);
      }
    } else if (t.ramFreeMb >= 6144) {
      score += 10;
      reasons.push(`+10 healthy RAM (${Math.round(t.ramFreeMb / 1024)}GB free)`);
    }

    // CPU load modifier (tiered saturation penalty)
    const loadPerCore = t.cpuCores > 0 ? t.load1m / t.cpuCores : 0;
    if (loadPerCore >= 2.25) {
      score -= 85;
      reasons.push(`-85 CPU pegged (${t.load1m.toFixed(1)}/${t.cpuCores}c)`);
    } else if (loadPerCore >= 1.5) {
      score -= 55;
      reasons.push(`-55 CPU saturated (${t.load1m.toFixed(1)}/${t.cpuCores}c)`);
    } else if (loadPerCore > 0.85) {
      score -= 20;
      reasons.push(`-20 high CPU load (${t.load1m.toFixed(1)}/${t.cpuCores}c)`);
    } else if (loadPerCore < 0.35) {
      score += 6;
      reasons.push("+6 low CPU load");
    }

    // Workload <-> role affinity
    if (isVmPreferred) {
      if (node.role === "vm") {
        score += 40;
        reasons.push(`+40 VM preferred for ${workload}`);
      } else if (node.role === "workstation") {
        score -= 10;
        reasons.push(`-10 keep workstation free from ${workload} work`);
      }
      if (node.capabilities.includes(workload) || node.capabilities.includes("research")) {
        score += 10;
        reasons.push(`+10 capability match (${workload})`);
      }
    }

    if (isHeavy) {
      if (node.role === "workstation") {
        score += 45;
        reasons.push(`+45 workstation preferred for ${workload}`);
      } else if (node.role === "vm") {
        if (!allowFallback) {
          eligible = false;
          reasons.push("VM skipped for heavy workload (fallback disabled)");
        } else {
          score -= 15;
          reasons.push("-15 VM fallback for heavy workload");
        }
      }
      if (node.capabilities.includes("heavy") || node.capabilities.includes("build")) {
        score += 10;
        reasons.push("+10 heavy capability match");
      }
    }

    if (isMobile) {
      if (hasDevice(node, req.requireDevice)) {
        score += 60;
        reasons.push(`+60 attached ${req.requireDevice ?? "mobile"} device`);
      } else if (node.role === "device-host" || node.capabilities.includes("mobile")) {
        score += 20;
        reasons.push("+20 mobile device host");
      } else if (!allowFallback) {
        eligible = false;
        reasons.push("no matching mobile device attached");
      } else {
        score -= 25;
        reasons.push("-25 no attached mobile device");
      }
    }

    // Project checkout bonus
    if (req.project) {
      const matched = matchProject(node, req.project);
      if (matched) {
        score += 18;
        reasons.push(`+18 has project "${matched.title}"`);
      }
    }

    // Explicit caller preference
    if (
      req.preferredNode &&
      (node.nodeId === req.preferredNode ||
        node.name.toLowerCase() === req.preferredNode.toLowerCase())
    ) {
      score += 50;
      reasons.push("+50 explicitly preferred node");
    }

    scores.push({
      nodeId: node.nodeId,
      name: node.name,
      role: node.role,
      eligible,
      score,
      reasons,
    });
  }

  scores.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    return b.score - a.score;
  });

  const winnerScore = scores.find((s) => s.eligible);
  const selectedNode = winnerScore
    ? (nodes.find((n) => n.nodeId === winnerScore.nodeId) ?? null)
    : null;

  const fallbackUsed = Boolean(
    selectedNode &&
      ((isHeavy && selectedNode.role !== "workstation") ||
        (isVmPreferred && selectedNode.role !== "vm") ||
        (isMobile && !hasDevice(selectedNode, req.requireDevice))),
  );

  const reason = selectedNode
    ? `Routed ${workload} task to ${selectedNode.name} (${selectedNode.role}, score ${winnerScore!.score}): ${winnerScore!.reasons.join(", ")}`
    : `No eligible online node for ${workload} task (${scores.map((s) => `${s.name}: ${s.reasons.join("; ")}`).join(" | ") || "no nodes registered"})`;

  return {
    inferredWorkload: workload,
    selectedNode,
    matchedProject: selectedNode ? matchProject(selectedNode, req.project) : null,
    fallbackUsed,
    reason,
    scores,
  };
}

export function buildRebalanceSuggestions(
  nodes: NodeRecord[],
  threads: StoredThread[],
): RebalanceSuggestion[] {
  const suggestions: RebalanceSuggestion[] = [];
  const onlineNodes = nodes.filter((n) => n.status === "online");

  for (const node of nodes) {
    if (node.status === "offline") {
      suggestions.push({
        kind: "offline_node",
        severity: "info",
        nodeId: node.nodeId,
        message: `${node.name} is offline (last seen ${node.lastSeenAt}). New work will route to online nodes.`,
      });
      continue;
    }

    const t = node.telemetry;
    if (t.ramUsedPct >= 85 || (t.ramTotalMb > 0 && t.ramFreeMb < 1536 && node.role !== "tiny")) {
      const other = onlineNodes.find(
        (n) => n.nodeId !== node.nodeId && n.telemetry.ramFreeMb > t.ramFreeMb + 2048,
      );
      suggestions.push({
        kind: "overloaded_node",
        severity: "warn",
        nodeId: node.nodeId,
        message: other
          ? `${node.name} is memory-tight (${t.ramFreeMb}MB free). Shift new tasks to ${other.name} (${other.telemetry.ramFreeMb}MB free).`
          : `${node.name} is memory-tight (${t.ramFreeMb}MB free). Pause low-priority threads before spawning more.`,
      });
    }

    const loadPerCore = t.cpuCores > 0 ? t.load1m / t.cpuCores : 0;
    if (loadPerCore >= 1.5) {
      const cooler = onlineNodes
        .filter((n) => n.nodeId !== node.nodeId && n.role !== "tiny")
        .map((n) => ({
          node: n,
          lpc: n.telemetry.cpuCores > 0 ? n.telemetry.load1m / n.telemetry.cpuCores : Number.POSITIVE_INFINITY,
        }))
        .filter((x) => x.lpc < 1.0)
        .sort((a, b) => a.lpc - b.lpc)[0]?.node;
      suggestions.push({
        kind: "overloaded_node",
        severity: "warn",
        nodeId: node.nodeId,
        message: cooler
          ? `${node.name} CPU is saturated (${t.load1m.toFixed(1)}/${t.cpuCores}c). Shift new tasks to ${cooler.name} (${cooler.telemetry.load1m.toFixed(1)}/${cooler.telemetry.cpuCores}c) until CPU load drops.`
          : `${node.name} CPU is saturated (${t.load1m.toFixed(1)}/${t.cpuCores}c). Shift new tasks to a cooler online peer until CPU load drops.`,
      });
    }
  }

  for (const th of threads) {
    if (th.stalled && !th.settled && !th.dismissedAt) {
      suggestions.push({
        kind: "stalled_thread",
        severity: "warn",
        nodeId: th.nodeId,
        threadId: th.threadId,
        message: `Thread "${th.title}" on ${th.nodeId} appears stalled (no progress since ${th.lastProgressAt}). Consider steering or reassigning.`,
      });
    }
  }

  return suggestions;
}
