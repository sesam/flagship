# What We Learnt Building & Running Flagship Live

Flagship didn't start from a whitepaper — it was built rapidly and debugged live across a Linux cloud VM, an Apple Silicon MacBook Pro, and Cloudflare Workers. Every feature below came directly from something that broke or annoyed us in real use.

---

## 1. Zero-Token Watching Beats Polling Every Time
Asking an LLM to sleep/poll other threads burns tokens and fills its context window with *"still running"* noise.
- **What worked:** Moving observation into a tiny stdlib Python process (`Lookout`, ~2.5–12 MB RAM) that diffs thread state locally and sends state transitions to Flagship Hub. The Hub only pushes a webhook to Helm when something actually transitions (`completed`, `failed`, `needs_input`, or `stalled` >20m with no item movement).

## 2. Prevent Self-Wakeup Loops on Day One
When Helm itself is a T3 thread watched by Lookout, Helm finishing a turn looks like `running -> completed` — which triggers a webhook that wakes Helm up to inspect itself, creating an infinite loop.
- **What worked:** Belt-and-suspenders suppression at **both** layers:
  1. Hub-side: `helm webhook set <url> --thread-id <currentThreadId>` stores `helm_thread_id`, and `FlagshipHubCore` suppresses all event recording and webhook pushes for that thread ID.
  2. T3-side: `/helm` attaches a webhook filter (`body.events[].threadId notEquals <currentThreadId>`) plus a 60-second coalesce window.

## 3. Don't Read T3's `statev2.sqlite` Directly — Use the CLI in Parallel
Opening T3 Code's live `statev2.sqlite` directly from an external watcher risks SQLite write lock contention.
- **What worked:** Calling `t3 --log-level none thread list --project <path> --json` across discovered repos using a 4-worker `ThreadPoolExecutor`.
- **Bonus gotcha caught live:** Some `t3` CLI builds emit migration `WARN` lines to **stdout** before the JSON array. `extract_json_payload()` defensively skips any leading log lines before `[` or `{`.

## 4. Static Role Affinity Isn't Enough — Add Tiered CPU Saturation Shifting
Routing all research/small tasks to a 4-core VM works great until the VM's 1-minute load average spikes to `10.8 / 4c` while your 10-core laptop sits cool at `1.2 / 10c`.
- **What worked:** Tiered CPU load penalties (`>0.85/core: -20`, `>=1.50/core: -55`, `>=2.25/core: -85`) plus automatic `overloaded_node` rebalance warnings in `helm overview`. Research and scaffolding still prefer the VM by default, but automatically spill over to a healthy workstation whenever the VM is pegged.

## 5. Executive Views Need Aggressive Noise Hygiene
Within hours, `Needs Attention` filled up with yesterday's obsolete `[FAILED]` experiment threads, burying real blockers.
- **What worked:**
  - Automatically filter `failed`/`interrupted` threads older than 24 hours out of `Needs Attention` (while keeping `waiting` and `stalled` visible).
  - Add `helm dismiss <threadId>` and `helm dismiss --all-failed` so you can clear resolved failures in one command — and automatically clear the dismissal if that thread ever starts running again.

## 6. macOS LaunchAgent Real-World Gotchas
Two subtle macOS bugs only showed up once Lookout ran under `launchd`:
1. **`RAM 0/0MB free`:** `launchd` does not include `/usr/sbin` in `PATH` by default, so `sysctl` wasn't found! Fix: resolve `/usr/sbin/sysctl` explicitly and include `/usr/sbin:/sbin` in the LaunchAgent plist.
2. **SSL verification & pyenv shims:** Some macOS Python builds lack a default CA bundle under `launchd`, and `command -v python3` can point to a pyenv shim instead of the real binary. Fix: fall back to `/etc/ssl/cert.pem` in `ssl.create_default_context()` and embed `sys.executable` in `install-macos.sh`.

## 7. Executive Prompting: Two-Way Doors, Absolute Impact & No Wide Tables
Running Helm as a true C-level layer taught us four prompt patterns that dramatically improved signal-to-noise:
- **Two-way vs One-way Doors:** Let workers commit, push, and deploy easily revertible changes autonomously; stop and escalate to Helm only for hard-to-revert changes, explicit staging holds, or surprise scope expansion.
- **Absolute User Impact + Nudge-vs-Build:** Never triage UX/product work on engineering effort or relative percentages alone — require absolute production user volume and ask whether a tiny UX nudge beats building complex code.
- **Keep Team Rules Local (`~/.flagship/policy.md`):** Keep the Flagship repo generic and reusable; put your company's repo names, QA holds, and analytics tools in a local `~/.flagship/policy.md` that Helm loads automatically.
- **Structured Text Over Wide Markdown Tables:** Wide markdown tables wrap poorly in narrow chat panes and mobile views. Short bulleted buckets (**Needs Your Decision** · **Shipped / Ready** · **In Flight** · **Captured Ideas**) with clickable T3 thread links read 3× faster.

## 8. Pass Prompts via Stdin (`-`), Never Positional Argv
Passing free-form prompts as CLI arguments risks flag injection (if a prompt starts with `-`) and exposes prompt text in `ps` listings.
- **What worked:** `t3 thread start <project> -` and `t3 thread send <threadId> -` with `input=prompt`, paired with an explicit allowed-projects check on each Lookout node.
