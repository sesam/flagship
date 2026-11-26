# Flagship Setup Guide

Get **Flagship** (Hub), **Lookout** (machine watchers), and **Helm** (your T3 Code executive thread) running in ~5 minutes.

## Prerequisites

- [T3 Code](https://github.com/pingdotgg/t3code) running on at least one machine (`t3` CLI on `PATH`)
- A Cloudflare account (Free plan works — Flagship uses SQLite-backed Durable Objects)
- Python 3.10+ on each machine (uses stdlib only — no `pip install` needed)

---

## 1. Deploy Flagship Hub to Cloudflare

```bash
git clone https://github.com/sesam/flagship.git
cd flagship/hub
npm install

# Generate a strong secret token (keep it private!)
mkdir -p ~/.flagship && chmod 700 ~/.flagship
(umask 077 && openssl rand -hex 32 > ~/.flagship/token)

npx wrangler deploy
npx wrangler secret put FLAGSHIP_TOKEN < ~/.flagship/token
```

Verify the Hub is live:

```bash
curl -fsS https://flagship-hub.<your-subdomain>.workers.dev/health
```

---

## 2. Start Lookout on Each Machine

Copy `~/.flagship/token` securely (e.g. over SSH with `chmod 600`) to each machine you want in your fleet, then initialize and start **Lookout**.

### Linux (Cloud VM or Linux Desktop)

```bash
python3 lookout/lookout.py init \
  --hub https://flagship-hub.<your-subdomain>.workers.dev \
  --token "$(cat ~/.flagship/token)" \
  --node-id cloud-vm --name "Cloud VM" --role vm --max-slots 6 \
  --scan-dirs ~/projects

python3 lookout/lookout.py once   # send one heartbeat to verify
./lookout/install-linux.sh        # installs systemd --user service
```

### macOS (Workstation / MacBook)

```bash
python3 lookout/lookout.py init \
  --hub https://flagship-hub.<your-subdomain>.workers.dev \
  --token "$(cat ~/.flagship/token)" \
  --node-id dev-laptop --name "Dev Laptop" --role workstation --max-slots 4 \
  --scan-dirs ~/projects

python3 lookout/lookout.py once   # send one heartbeat to verify
./lookout/install-macos.sh        # installs LaunchAgent
```

### Tiny Box (1 GB Raspberry Pi 3+ / Mobile Test Device Host)

```bash
python3 lookout/lookout.py init \
  --hub https://flagship-hub.<your-subdomain>.workers.dev \
  --token "$(cat ~/.flagship/token)" \
  --node-id office-rpi --name "Office RPi" --role tiny --max-slots 2
./lookout/install-linux.sh
```

*(Plug in Android phones/tablets via `adb` or iOS devices via `idevice_id`/`xcrun` and Lookout automatically reports them to Flagship.)*

---

## 3. Install & Launch Helm in T3 Code

```bash
./helm/install.sh
```

*(Optional)* Copy `helm/POLICY.example.md` to `~/.flagship/policy.md` to define your team's deploy rules, staging holds, and product metrics without committing private config to git.

Then open a fresh T3 Code thread and run:

```text
/helm
```

In one turn, **Helm** loads its instructions, binds a deduplicated T3 wakeup webhook (with self-wakeup suppression enabled), and prints a 4-line fleet status banner.

---

## 4. Default Routing Policy

| Task Type | Preferred Machine | Examples |
|---|---|---|
| `small`, `slow`, `research`, `scaffolding` | **Cloud VM** (`role: vm`) | Research, specs, triage, scaffolding, docs, background checks |
| `heavy`, `build` | **Workstation** (`role: workstation`) | Vite/Next/3D builds, Playwright, large refactors, CPU/RAM-heavy jobs |
| `mobile` | Any node with an attached Android (`adb`) or iOS device | Real phone/tablet UI & app testing |
| `tiny` | **1 GB Raspberry Pi 3+** (`role: tiny`) or VM | Lightweight watchers, webhooks, USB device host (never gets heavy builds) |

Flagship automatically shifts work to a healthier peer if a node gets CPU-saturated (`load1m / cores >= 1.5`), low on RAM, or goes offline.

---

## 5. Everyday CLI Controls

```bash
helm overview                                          # C-level fleet briefing
helm route "Build Three.js scene preview" --project web-app
helm idea add "Audit mobile checkout latency" --priority P1 --project web-app
helm dismiss --all-failed                              # clear old [FAILED] noise
helm stand-down "Stepping away"                        # hard pause wakeups & dispatch
helm resume                                            # resume automation
```

---

## 6. Optional Integrations

- **MCP Clients & Aggregators:** Flagship Hub serves Streamable HTTP MCP at `POST /mcp` (`Authorization: Bearer <FLAGSHIP_TOKEN>`) with 10 tools (`flagship_overview`, `flagship_route`, `flagship_idea_add`, `flagship_idea_update`, `flagship_dispatch`, `flagship_send`, `flagship_dismiss`, `flagship_stand_down`, `flagship_resume`, `flagship_events`). See [helm/QUICKSTART.md](../helm/QUICKSTART.md).
- **Executive Overview Dashboards:** Poll `GET /api/overview` (Bearer auth) — see [docs/overview-api.md](overview-api.md).
