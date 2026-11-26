# Security Model & Pre-Sharing Guide

Flagship is designed to be simple to self-host and safe when deployed properly. **Read this before sharing your Flagship Hub instance with another person.**

---

## Trust Boundary (Current v0.1 — Single-Operator Model)

Today, Flagship uses a **single shared Bearer token (`FLAGSHIP_TOKEN`)** to authenticate:
- Lookout nodes posting heartbeats and claiming commands (`/api/nodes/heartbeat`, `/api/commands/:id/result`)
- Helm CLI / MCP clients reading overviews and queuing dispatches (`/api/overview`, `/api/dispatch`, `/api/threads/send`, `/mcp`)
- Control endpoints (`/api/control/webhook`, `/api/control/stand-down`)

### What That Means in Practice
- **Anyone who holds `FLAGSHIP_TOKEN` can queue `launch_thread` or `send_message` on any connected Lookout node.** Because T3 Code threads often run with `full-access`, treat `FLAGSHIP_TOKEN` with the same care as an SSH private key.
- **Safe right now:** Each person clones this repo, deploys their **own** Cloudflare Worker, and generates their **own** `FLAGSHIP_TOKEN` for their own machines.
- **Not safe yet:** Giving your personal `FLAGSHIP_TOKEN` to another person, or attaching someone else's untrusted machine to your single-token Hub. Multi-user isolation requires Phase 2 (**Flotilla**): per-user/per-node scoped credentials and containerized sandbox execution for cross-user jobs so guest tasks can never read host secrets.

---

## Built-In Protections

| Area | Protection |
|---|---|
| **Authentication** | Constant-time Bearer token comparison (`hub/src/index.ts`). Fail-closed `503` if `FLAGSHIP_TOKEN` is unset. `/health` exposes only service name, version, and route list. |
| **SQL Injection** | 100% parameterized SQLite queries across `hub/src/core.ts`; zero string interpolation of user input into SQL. |
| **Command & Flag Injection** | `lookout/lookout.py` uses `subprocess.run(argv_list)` (never `shell=True`), passes prompts/messages via **stdin (`-`)** instead of CLI args, rejects leading `-` on option values (`threadId`, `worktree`, `branch`, `provider`, `model`, `project`), and enforces an **allowed-projects list** so remote `launch_thread` cannot target arbitrary filesystem directories like `/etc` or `~`. |
| **Webhook SSRF Guard** | `POST /api/control/webhook` requires `https://` (allowing `http://localhost` / `http://127.0.0.1` for local dev only) and blocks cloud metadata hosts (`169.254.169.254`, `metadata.google.internal`). |
| **Webhook Signing & Prompt Injection** | Outbound webhooks support HMAC-SHA256 signing (`X-Flagship-Signature: sha256=...`). Helm treats all webhook payload text as **untrusted data** and verifies state via `t3_thread_read` before taking action. |
| **CORS** | Fail-closed by default (omits `Access-Control-Allow-Origin` unless you explicitly configure `CORS_ORIGIN` in Cloudflare Worker vars for a trusted dashboard origin). |
| **Secret Storage on Disk** | `lookout.py init` writes `~/.flagship/lookout.json` with `0600` permissions; keep `~/.flagship/` at `0700` and never commit `lookout.json`, `token`, `policy.md`, or `logs/`. |
| **Bounded Storage** | Durable Object automatically retains the latest 500 events and 200 finished commands to prevent unbounded SQLite growth. |
| **Hard Kill Switch** | `helm stand-down` stops both webhook wakeups and new command claims in Hub state (enforced in code, not just in LLM prompts). |

---

## Checklist Before Making a Fork or Clone Public

1. Keep your personal deploy rules, repo names, and analytics config in `~/.flagship/policy.md` — never commit them.
2. Verify `git status` shows no `logs/`, `.env`, `.dev.vars`, or `*.local.json` files.
3. If your repo's earlier git history contains internal machine names, paths, or emails you don't want public, squash to a fresh initial commit before switching visibility from private to public.
4. Rotate `FLAGSHIP_TOKEN` immediately (`npx wrangler secret put FLAGSHIP_TOKEN`) if a machine is lost or a token is ever exposed.
