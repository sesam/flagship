# Flagship Architecture & Portability Notes

## Two-Tier Design

1. **Tier 1 — Lookout (`lookout/lookout.py`)**
   - Zero-dependency Python 3 stdlib (~2.5–12 MB RSS).
   - Outbound HTTPS only (`POST /api/nodes/heartbeat`, `POST /api/commands/:id/result`), so it works behind home NAT, inside Windows VMs, on cloud VMs, on macOS, and on a 1 GB Raspberry Pi 3+.
   - Safe T3 observation: invokes `t3 --log-level none thread list --project <path> --json` in parallel instead of opening `statev2.sqlite` directly (avoids SQLite writer stalls).
   - Safe remote dispatch: passes prompts via stdin (`-`) and validates target directories against the node's allowed projects list.
   - Future Rust rewrite: only needs to implement the same two HTTP endpoints (`HeartbeatPayload` + `CommandRecord`).

2. **Tier 2 — Flagship Hub (`hub/`)**
   - Cloudflare Worker + single SQLite-backed Durable Object (`FlagshipHub`), with storage-agnostic core logic in `hub/src/core.ts` (`FlagshipHubCore`).
   - Portable SQL schema (`control`, `nodes`, `threads`, `ideas`, `commands`, `events`) — can later run directly on a private Raspberry Pi 3+ or home server using local SQLite with identical `/api/*` and `/mcp` contracts.
   - Zero-token T3 wakeup: on real thread transitions (`completed`, `failed`, `needs_input`, `stalled`), Hub POSTs a signed webhook (`X-Flagship-Signature: sha256=...`) to Helm's `schedule_task` webhook, automatically suppressing self-wakeups for `helm_thread_id`.

## Future Flotilla (Multi-User Shared Pool)

Already modeled in `hub/src/types.ts` and `hub/src/router.ts`:
- Each node records `owner` and `quota: { businessMaxSharePct: 90, spotMinFreeRamPct: 50 }`.
- Each task/idea carries `visibility: "business" | "public" | "private-spot"`.
- Non-owner `private-spot` work is blocked whenever host free RAM drops below `spotMinFreeRamPct`.
- Phase 2 adds per-user/per-node scoped API keys, fair-share slot accounting (with a bonus multiplier for `public` tasks), and containerized sandbox execution for cross-user tasks so guest code never touches host secrets.
