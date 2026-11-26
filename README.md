# Flagship

**Step up to the bridge. Let your machines run the engine room.**

<!-- IMAGE SLOT 1: Hero banner — drop image at docs/assets/hero.png and uncomment:
![Flagship](docs/assets/hero.png)
-->

## The Story

Running a **fleet** (your computers, cloud servers, and spare test devices working together as one) shouldn't mean spending your day trapped in the **engine room** (the noisy pile of tabs, terminals, and background jobs doing the actual lifting).

Flagship moves you up to the **bridge** (one calm view where you only see what matters):

- You drop every raw idea, fix, or priority into **Helm** (where you get slim reports and decide what your fleet should do). **Helm** never gets bogged down doing the chores itself — it hands every real job off to the right crew and keeps your desk quiet.
- On every machine sits a **Lookout** (a tiny, quiet watcher that keeps an eye on free memory, workload, attached phones, and active jobs).
- Holding everything together is the **Flagship** (the central hub that routes light, slow, or research jobs to your cloud machine, heavy lifting to your main computer, and mobile checks to whichever device has a phone plugged in — waking **Helm** only when a job finishes, stalls, or needs your call).
- When teammates or friends join in later, multiple fleets can sail together as a **Flotilla** (a shared pool where core work always keeps priority and side projects borrow idle capacity).

<!-- IMAGE SLOT 2: Fleet overview — drop image at docs/assets/overview.png and uncomment:
![Flagship Fleet Overview](docs/assets/overview.png)
-->

## Start Here

- **[Setup Guide](docs/setup.md)** — deploy **Flagship**, start **Lookout** on your machines, and launch **Helm** (~5 minutes)
- **[Helm Quickstart](helm/QUICKSTART.md)** — `/helm` command, daily CLI controls, and MCP hookup
- **[What We Learnt](docs/lessons-learned.md)** — real-world lessons from running the fleet live
- **[Architecture](docs/architecture.md)** · **[Overview API](docs/overview-api.md)** · **[Security](SECURITY.md)**

### Two Important Caveats Before You Start

1. **Deploy your own Hub — never share your `FLAGSHIP_TOKEN`:** v0.1 uses a single shared token that can launch and steer work on every connected machine. Each person should deploy their own Cloudflare Worker with their own token until **Flotilla** (Phase 2) adds per-user keys and sandboxed guest execution. See [SECURITY.md](SECURITY.md).
2. **Keep personal & company rules out of git:** Put repo-specific deploy holds, private tool names, and team policies in `~/.flagship/policy.md` (local only — see [helm/POLICY.example.md](helm/POLICY.example.md)). Never commit `~/.flagship/`, `.env`, or `logs/`.

### Requirements

- **[T3 Code](https://github.com/pingdotgg/t3code)** installed on the machines you want to coordinate (`t3` CLI on `PATH`)
- **Cloudflare account** (Free plan works — Flagship runs on a Worker + SQLite Durable Object)
- **Python 3.10+** on each machine (**Lookout** and **Helm CLI** use Python stdlib only — zero dependencies to install)

---

## What It Gives You

- **Idea inbox to action:** Dump rough ideas into **Helm**; it logs them, ranks priorities, and dispatches each job to an outside worker thread automatically.
- **Automatic load balancing:** Small, slow, and research jobs go to your always-on VM; heavy builds go to your main computer; if a machine gets hot or goes offline, work shifts automatically.
- **Quiet by default:** **Lookout** watches in the background without spending AI tokens and only wakes **Helm** when something finishes, stalls, or needs your decision.
- **Instant pause:** Say *"stand down"* anytime to halt new dispatches and wakeups immediately.

<!-- IMAGE SLOT 3: Helm in action — drop image at docs/assets/helm-t3.png and uncomment:
![Helm in action](docs/assets/helm-t3.png)
-->

---

## Example Real-World Setup

Here is a typical small personal fleet running on Flagship today:

- **Cloud Linux VM (`role: vm`, 4 vCPU / 16 GB RAM, always on):** Owns all small, slow, scaffolding, docs, triage, and research jobs. Keeps the laptop cool and quiet, and keeps working even when the laptop lid is closed.
- **Main Laptop / MacBook (`role: workstation`, 10 CPU / 16+ GB RAM):** Owns CPU- and memory-heavy work — frontend/3D builds, Playwright browser tests, large refactors, and interactive work. Automatically absorbs overflow if the cloud VM's CPU gets pegged.
- **Office Spare Box / 1 GB Raspberry Pi 3+ (`role: tiny` or `device-host`, optional):** Runs **Lookout** in ~10 MB of RAM with old Android phones/tablets (`adb`) or an always-on iPhone attached for real-device mobile testing — never receives heavy builds.
- **Flagship Hub (Cloudflare Worker):** Connects all machines over outbound HTTPS (zero open inbound ports, works behind home NAT and inside Windows VMs).
- **Helm (one pinned T3 Code thread) + External Overview App:** You spam ideas into **Helm** all day, let it reorganize and steer stalled workers, and optionally point a lightweight dashboard at `GET /api/overview` for a calm C-level view without opening dozens of T3 tabs.

## License

[MIT](LICENSE)
