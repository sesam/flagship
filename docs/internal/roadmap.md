# Flagship Internal Roadmap & Future Work

*Working backlog kept under `docs/internal/` so the top-level repo stays slim while we learn from daily single-user use before generalizing.*

## Phase 1 — Single-User Polish (Learn From Practice First)

- **MCP aggregator hookup:** Register Flagship Hub's `/mcp` endpoint (`POST /mcp` + Bearer token) in local MCP aggregator setups once upgraded to MCP 2.0.
- **External executive overview UI:** Wire a calm C-level web/container dashboard to `GET /api/overview` (machines, RAM/CPU, mobile devices, active threads, needs-attention, idea backlog, rebalance hints).
- **Real mobile test lab:**
  - Add a Windows VM and a 1 GB Raspberry Pi 3+ (`role: tiny` / `device-host`).
  - Plug in always-on spare Android phones/tablets (`adb`) and an office iPhone (`idevice_id` / `xcrun`).
  - Add simple **device lease locking** on Hub so two mobile test threads never collide on the same physical phone/tablet.
- **Side-effect stall detection:** Upgrade stall detection from thread `itemCount`/timestamp movement alone to real side-effect signals (git commits, branch updates, PR activity) so chatty no-progress loops are caught too.

## Phase 1.5 — Portability & Ultra-Low Footprint

- **Rust Lookout binary:** Drop-in replacement implementing the exact same two HTTP endpoints (`POST /api/nodes/heartbeat`, `POST /api/commands/:id/result`) as a ~4–5 MB static binary for `x86_64-linux`, `aarch64-linux`, `armv7` (RPi 3+), `darwin-arm64`, and Windows.
- **Self-hosted private Hub (`--mode hub`):** Run `FlagshipHubCore` (same SQLite schema + `/api/*` + `/mcp` contract) directly on a private RPi 3+ or home server with zero Cloudflare dependency.

## Phase 2 — Flotilla (Multi-User Shared Capacity Pool)

Only build once single-user workflows and guardrails are battle-tested:

- **Per-user & per-node scoped credentials:** Replace single shared `FLAGSHIP_TOKEN` with least-privilege node tokens (heartbeat + own-node command claim only) and operator tokens.
- **3-tier resource quotas & preemption:**
  - `business` / owner work: up to **90%** guaranteed on owner hardware; immediately preempts/pauses guest spot jobs when owner load rises.
  - `public` (build-in-public / OSS tasks): higher burst priority and credit bonus to reward building in public.
  - `private-spot` (private side projects / play): strictly **spot-only** on other participants' idle capacity (blocked whenever host free RAM drops below `spotMinFreeRamPct`).
- **Lightweight fair-share ledger:** Track contributed vs consumed slot-minutes weighted by node class and discounted for `public` work, benefiting always-on contributors and public builders.
- **Sandboxed guest execution:** Cross-user jobs must **never** run directly on a host's bare T3 Code instance (where host SSH keys, `.env`s, and tokens live); execute guest jobs strictly inside ephemeral isolated containers/microVMs with zero host secrets.
