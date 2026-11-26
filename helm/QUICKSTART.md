# Helm Quickstart (Operator Reference)

## 1. One-Time Install (Linux & macOS)

```bash
cd /path/to/flagship
./helm/install.sh
```

Installs idempotent symlinks for `helm` (`~/.local/bin/helm`), the `helm` skill (OpenCode + Claude Code), and the `/helm` slash command (OpenCode + Claude Code). Restart OpenCode/Claude Code once if already running so `/helm` is picked up.

*(Optional)* Copy `helm/POLICY.example.md` to `~/.flagship/policy.md` and customize your repo deploy rules, QA holds, and product analytics sources. That file stays local on your machine and out of git.

## 2. Start a Fresh Helm Home Thread (1 Command)

Open a new T3 thread and run:

```text
/helm
```

In one shot, the thread loads the `helm` skill + `AGENTS.md` (and `~/.flagship/policy.md` if present), discovers its own `threadId`, binds a deduplicated Flagship wakeup webhook (filtered against self-wakeups), registers `helm webhook set <url> --thread-id <id>`, and prints a 4-line live fleet banner.

## 3. Core Operator Controls

- **Fleet overview:** `helm overview` (or `helm overview --json`)
- **Dry-run routing:** `helm route "<title>" --project web-app`
- **Clear stale `[FAILED]` alerts:**
  - Single thread: `helm dismiss <threadId>`
  - All failed/interrupted threads: `helm dismiss --all-failed`
  - Dismissals clear automatically if that thread starts running again.
- **Hard pause (kill switch):** `helm stand-down "reason"` (stops wakeups & auto-dispatch)
- **Resume:** `helm resume`

## 4. Decision Policies Enforced by Helm

- **Two-way vs One-way Doors (Deploys):**
  - **Two-way doors** (easily revertible/toggleable): commit, push, and deploy immediately after verification (routing to whichever machine holds deploy credentials).
  - **One-way doors** (destructive, order-dependent, hard-to-revert, or major scope/impact change): stop before applying/deploying and escalate to Helm for explicit approval.
  - **Custom per-repo holds:** declare any staging-only or human-gated prod repos in `~/.flagship/policy.md`.
- **Impact Grounding + Nudge-vs-Build Lens:**
  - Pair technical scope with **real production absolute user counts** (volume + weekly run-rate), never percentages or engineering effort alone.
  - Prefer lightweight UX nudges toward the happy path rather than building maintenance-heavy code for tiny cohorts.
- **Briefing Style:** Regular structured text and bulleted blocks with clickable T3 links — no wide markdown tables.

## 5. Wiring Flagship Hub MCP (Optional)

Flagship Hub serves Streamable HTTP MCP at `https://<flagship-hub-host>/mcp` with Bearer auth (`FLAGSHIP_TOKEN`), exposing `flagship_overview`, `flagship_route`, `flagship_idea_add`, `flagship_idea_update`, `flagship_dispatch`, `flagship_send`, `flagship_dismiss`, `flagship_stand_down`, `flagship_resume`, and `flagship_events`.

Add it to any MCP aggregator or directly in `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "mcp": {
    "flagship": {
      "type": "remote",
      "url": "https://<your-flagship-hub>.workers.dev/mcp",
      "enabled": true,
      "headers": {
        "Authorization": "Bearer {env:FLAGSHIP_TOKEN}"
      }
    }
  }
}
```
