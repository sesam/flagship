#!/usr/bin/env python3
"""
Lookout — tiny, zero-dependency machine watcher & dispatcher for Flagship.

Runs on Linux (cloud VMs, Raspberry Pi 3+), macOS (MacBooks/workstations), and Windows.
Uses Python 3 stdlib only (~10-15 MB RSS) and outbound HTTPS only (no inbound ports).
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import ctypes
import getpass
import json
import os
import platform
import re
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DEFAULT_CONFIG_PATH = Path.home() / ".flagship" / "lookout.json"
RUNNING = True


def _handle_signal(_signum: int, _frame: Any) -> None:
    global RUNNING
    RUNNING = False


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def extract_json_payload(raw: str) -> Any:
    """Parse JSON even if t3 CLI prints WARN/INFO lines before the JSON."""
    text = raw.strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Find first line starting with '[' or '{'
    for idx, ch in enumerate(text):
        if ch in "[{":
            try:
                return json.loads(text[idx:])
            except json.JSONDecodeError:
                continue
    return None


def read_t3_environment_id(t3_home: str | None = None) -> str | None:
    base = Path(t3_home) if t3_home else Path.home() / ".t3"
    env_file = base / "userdata" / "environment-id"
    try:
        val = env_file.read_text(encoding="utf-8").strip()
        return val or None
    except OSError:
        return None


def collect_ram_mb() -> tuple[int, int, int]:
    """Return (ram_total_mb, ram_free_mb, ram_used_pct)."""
    sys_name = platform.system().lower()
    if sys_name == "linux":
        info: dict[str, int] = {}
        try:
            with open("/proc/meminfo", encoding="utf-8") as f:
                for line in f:
                    parts = line.split()
                    if len(parts) >= 2 and parts[1].isdigit():
                        info[parts[0].rstrip(":")] = int(parts[1])
            total_mb = info.get("MemTotal", 0) // 1024
            avail_kb = info.get("MemAvailable", info.get("MemFree", 0))
            free_mb = avail_kb // 1024
            used_pct = int(round(((total_mb - free_mb) / total_mb) * 100)) if total_mb > 0 else 0
            return total_mb, free_mb, max(0, min(100, used_pct))
        except OSError:
            return 0, 0, 0

    if sys_name == "darwin":
        try:
            sysctl_bin = shutil.which("sysctl") or "/usr/sbin/sysctl"
            vm_stat_bin = shutil.which("vm_stat") or "/usr/bin/vm_stat"
            total_bytes = int(
                subprocess.check_output([sysctl_bin, "-n", "hw.memsize"], timeout=3).decode().strip()
            )
            total_mb = total_bytes // (1024 * 1024)
            vm_out = subprocess.check_output([vm_stat_bin], timeout=3).decode()
            page_match = re.search(r"page size of (\d+) bytes", vm_out)
            page_size = int(page_match.group(1)) if page_match else 16384
            pages: dict[str, int] = {}
            for line in vm_out.splitlines():
                m = re.match(r"^([^:]+):\s+(\d+)\.", line)
                if m:
                    pages[m.group(1).strip().lower()] = int(m.group(2))
            avail_pages = (
                pages.get("pages free", 0)
                + pages.get("pages inactive", 0)
                + pages.get("pages speculative", 0)
                + pages.get("pages purgeable", 0)
            )
            free_mb = (avail_pages * page_size) // (1024 * 1024)
            used_pct = int(round(((total_mb - free_mb) / total_mb) * 100)) if total_mb > 0 else 0
            return total_mb, free_mb, max(0, min(100, used_pct))
        except Exception:
            return 0, 0, 0

    if sys_name == "windows":
        try:
            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("sullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            stat = MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))  # type: ignore[attr-defined]
            total_mb = int(stat.ullTotalPhys // (1024 * 1024))
            free_mb = int(stat.ullAvailPhys // (1024 * 1024))
            return total_mb, free_mb, int(stat.dwMemoryLoad)
        except Exception:
            return 0, 0, 0

    return 0, 0, 0


def collect_load_1m() -> float:
    try:
        return round(os.getloadavg()[0], 2)
    except (AttributeError, OSError):
        return 0.0


def collect_disk_free_gb() -> float:
    try:
        root = "C:\\" if platform.system().lower() == "windows" else "/"
        usage = shutil.disk_usage(root)
        return round(usage.free / (1024 ** 3), 1)
    except OSError:
        return 0.0


def detect_mobile_devices() -> list[dict[str, str]]:
    """Detect attached Android (adb) and iOS (idevice_id / xcrun) test devices."""
    devices: list[dict[str, str]] = []

    adb_bin = shutil.which("adb")
    if adb_bin:
        try:
            out = subprocess.check_output([adb_bin, "devices", "-l"], timeout=3, stderr=subprocess.DEVNULL).decode()
            for line in out.splitlines()[1:]:
                line = line.strip()
                if not line or line.startswith("*"):
                    continue
                parts = line.split()
                if len(parts) >= 2 and parts[1] in ("device", "unauthorized", "offline"):
                    model_m = re.search(r"model:(\S+)", line)
                    name = model_m.group(1).replace("_", " ") if model_m else parts[0]
                    devices.append(
                        {
                            "id": parts[0],
                            "platform": "android",
                            "name": name,
                            "state": parts[1],
                        }
                    )
        except Exception:
            pass

    idevice_bin = shutil.which("idevice_id")
    if idevice_bin:
        try:
            out = subprocess.check_output([idevice_bin, "-l"], timeout=3, stderr=subprocess.DEVNULL).decode()
            for udid in [l.strip() for l in out.splitlines() if l.strip()]:
                devices.append({"id": udid, "platform": "ios", "name": "iOS Device", "state": "connected"})
        except Exception:
            pass
    elif platform.system().lower() == "darwin":
        xcrun_bin = shutil.which("xcrun")
        if xcrun_bin:
            try:
                out = subprocess.check_output(
                    [xcrun_bin, "devicectl", "list", "devices", "--hide-default-columns", "--columns", "identifier", "name", "state"],
                    timeout=4,
                    stderr=subprocess.DEVNULL,
                ).decode()
                for line in out.splitlines():
                    if "available" in line.lower() or "connected" in line.lower():
                        parts = [p.strip() for p in re.split(r"\s{2,}", line.strip()) if p.strip()]
                        if len(parts) >= 2:
                            devices.append(
                                {
                                    "id": parts[0],
                                    "platform": "ios",
                                    "name": parts[1],
                                    "state": parts[2] if len(parts) > 2 else "connected",
                                }
                            )
            except Exception:
                pass

    return devices


def find_t3_binary(configured: str | None = None) -> str | None:
    if configured and Path(configured).exists():
        return configured
    found = shutil.which("t3")
    if found:
        return found
    local_candidate = Path.home() / ".local" / "bin" / "t3"
    if local_candidate.exists():
        return str(local_candidate)
    return None


def discover_projects(config: dict[str, Any]) -> list[dict[str, str]]:
    projects: list[dict[str, str]] = []
    seen_paths: set[str] = set()

    for p in config.get("projects", []):
        if isinstance(p, str):
            resolved = str(Path(p).expanduser())
            if resolved not in seen_paths and Path(resolved).is_dir():
                seen_paths.add(resolved)
                projects.append({"title": Path(resolved).name, "path": resolved})
        elif isinstance(p, dict) and p.get("path"):
            resolved = str(Path(p["path"]).expanduser())
            if resolved not in seen_paths and Path(resolved).is_dir():
                seen_paths.add(resolved)
                projects.append(
                    {
                        "title": str(p.get("title") or Path(resolved).name),
                        "path": resolved,
                        **({"id": str(p["id"])} if p.get("id") else {}),
                    }
                )

    for scan_dir in config.get("scanDirs", []):
        base = Path(scan_dir).expanduser()
        if not base.is_dir():
            continue
        try:
            for child in sorted(base.iterdir()):
                if not child.is_dir() or child.name.startswith("."):
                    continue
                if not (child / ".git").exists():
                    continue
                resolved = str(child)
                if resolved not in seen_paths:
                    seen_paths.add(resolved)
                    projects.append({"title": child.name, "path": resolved})
        except OSError:
            continue

    return projects


def poll_t3_threads(
    t3_bin: str | None,
    projects: list[dict[str, str]],
    max_projects_per_tick: int = 50,
) -> list[dict[str, Any]]:
    """Query active/recent T3 threads via t3 CLI without touching SQLite directly."""
    if not t3_bin or not projects:
        return []

    def _poll_one(proj: dict[str, str]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        try:
            proc = subprocess.run(
                [t3_bin, "--log-level", "none", "thread", "list", "--project", proj["path"], "--json"],
                capture_output=True,
                text=True,
                timeout=8,
            )
            if proc.returncode != 0:
                return out
            parsed = extract_json_payload(proc.stdout)
            if not isinstance(parsed, list):
                return out
            for th in parsed[:12]:
                if not isinstance(th, dict):
                    continue
                tid = th.get("threadId")
                if not tid:
                    continue
                # Skip old settled threads to keep heartbeat compact
                if th.get("settled") and th.get("status") not in ("running", "waiting", "failed"):
                    continue
                out.append(
                    {
                        "threadId": tid,
                        "projectId": th.get("projectId"),
                        "projectTitle": proj["title"],
                        "projectPath": proj["path"],
                        "title": th.get("title") or "(untitled)",
                        "link": th.get("link"),
                        "status": th.get("status") or "idle",
                        "settled": bool(th.get("settled", False)),
                        "snoozed": bool(th.get("snoozed", False)),
                        "itemCount": int(th.get("itemCount") or 0),
                        "updatedAt": th.get("updatedAt") or now_iso(),
                        "parentThreadId": th.get("parentThreadId"),
                    }
                )
        except Exception:
            return out
        return out

    observed: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    batch = projects[:max_projects_per_tick]
    with ThreadPoolExecutor(max_workers=min(4, len(batch))) as pool:
        for items in pool.map(_poll_one, batch):
            for item in items:
                tid = item["threadId"]
                if tid not in seen_ids:
                    seen_ids.add(tid)
                    observed.append(item)

    return observed


def _build_ssl_context() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    # macOS Python.org/pyenv builds sometimes lack a default CA bundle
    if not ctx.get_ca_certs() and Path("/etc/ssl/cert.pem").exists():
        ctx.load_verify_locations(cafile="/etc/ssl/cert.pem")
    return ctx


def http_json(
    url: str,
    token: str,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    timeout: int = 15,
) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "flagship-lookout/0.1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout, context=_build_ssl_context()) as resp:
        raw = resp.read().decode("utf-8")
        return json.loads(raw) if raw.strip() else {}


def _safe_cli_value(val: str, field: str) -> str:
    cleaned = val.strip()
    if not cleaned:
        raise ValueError(f"{field} is required")
    if cleaned.startswith("-"):
        raise ValueError(f"{field} must not start with '-'")
    return cleaned


def _resolve_allowed_project(project: str, allowed_projects: list[dict[str, str]] | None) -> str:
    cleaned = _safe_cli_value(project, "project")
    if not allowed_projects:
        return cleaned
    allowed_paths = {str(Path(p["path"]).expanduser().resolve()) for p in allowed_projects if p.get("path")}
    if cleaned == ".":
        # Default to first configured project when "." is requested
        first = next((p["path"] for p in allowed_projects if p.get("path")), ".")
        return str(Path(first).expanduser().resolve())
    # Match by project title/id or resolved path inside an allowed project
    for p in allowed_projects:
        if p.get("id") == cleaned or p.get("title", "").lower() == cleaned.lower():
            return str(Path(p["path"]).expanduser().resolve())
    candidate = str(Path(cleaned).expanduser().resolve())
    if candidate in allowed_paths:
        return candidate
    raise ValueError(f"Project '{cleaned}' is not in this node's allowed projects list")


def execute_command(
    t3_bin: str | None,
    cmd: dict[str, Any],
    allowed_projects: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    kind = cmd.get("kind")
    payload = cmd.get("payload") or {}
    if not t3_bin:
        return {"ok": False, "error": "t3 CLI is not installed on this node"}

    if kind == "launch_thread":
        prompt = str(payload.get("prompt") or payload.get("title") or "").strip()
        title = str(payload.get("title") or "").strip()
        if not prompt:
            return {"ok": False, "error": "Missing prompt in launch_thread payload"}

        try:
            project = _resolve_allowed_project(str(payload.get("project") or "."), allowed_projects)
            argv = [t3_bin, "--log-level", "none", "thread", "start", "--json"]
            if title:
                argv += ["--title", title]
            if payload.get("worktree"):
                argv += ["--worktree", _safe_cli_value(str(payload["worktree"]), "worktree")]
            if payload.get("branch"):
                argv += ["--branch", _safe_cli_value(str(payload["branch"]), "branch")]
            if payload.get("provider") and payload.get("model"):
                argv += [
                    "--provider",
                    _safe_cli_value(str(payload["provider"]), "provider"),
                    "--model",
                    _safe_cli_value(str(payload["model"]), "model"),
                ]
            # Pass prompt via stdin ('-') so leading '-' cannot inject flags and prompt stays out of argv/ps
            argv += [project, "-"]
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}

        try:
            proc = subprocess.run(argv, input=prompt, capture_output=True, text=True, timeout=45)
            parsed = extract_json_payload(proc.stdout)
            if proc.returncode != 0:
                return {
                    "ok": False,
                    "error": (proc.stderr or proc.stdout).strip()[:800],
                    "returncode": proc.returncode,
                }
            if isinstance(parsed, dict):
                return {
                    "ok": True,
                    "threadId": parsed.get("threadId") or parsed.get("id"),
                    "threadLink": parsed.get("link"),
                    "raw": parsed,
                }
            return {"ok": True, "threadId": proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else None}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    if kind == "send_message":
        message = str(payload.get("message") or "").strip()
        try:
            thread_id = _safe_cli_value(str(payload.get("threadId") or ""), "threadId")
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}
        if not message:
            return {"ok": False, "error": "threadId and message are required"}
        argv = [t3_bin, "--log-level", "none", "thread", "send", "--json", thread_id, "-"]
        try:
            proc = subprocess.run(argv, input=message, capture_output=True, text=True, timeout=30)
            if proc.returncode != 0:
                return {"ok": False, "error": (proc.stderr or proc.stdout).strip()[:800]}
            return {"ok": True, "threadId": thread_id, "raw": extract_json_payload(proc.stdout)}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    return {"ok": False, "error": f"Unknown command kind: {kind}"}


def build_heartbeat(config: dict[str, Any], include_threads: bool = True) -> dict[str, Any]:
    ram_total, ram_free, ram_pct = collect_ram_mb()
    t3_bin = find_t3_binary(config.get("t3Bin"))
    projects = discover_projects(config)
    threads = poll_t3_threads(t3_bin, projects) if include_threads else []
    active_statuses = {"running", "starting", "queued", "preparing"}
    active_threads = sum(1 for t in threads if not t.get("settled") and t.get("status") in active_statuses)
    devices = detect_mobile_devices() if config.get("probeDevices", True) else []

    return {
        "nodeId": config["nodeId"],
        "name": config["name"],
        "role": config.get("role", "vm"),
        "environmentId": config.get("environmentId") or read_t3_environment_id(config.get("t3Home")),
        "owner": config.get("owner") or getpass.getuser(),
        "platform": platform.system().lower(),
        "arch": platform.machine().lower(),
        "capabilities": config.get("capabilities", []),
        "projects": projects,
        "telemetry": {
            "ramTotalMb": ram_total,
            "ramFreeMb": ram_free,
            "ramUsedPct": ram_pct,
            "cpuCores": os.cpu_count() or 1,
            "load1m": collect_load_1m(),
            "diskFreeGb": collect_disk_free_gb(),
            "activeThreads": active_threads,
            "maxSlots": int(config.get("maxSlots", 4)),
            "devices": devices,
        },
        "threads": threads,
        "quota": config.get("quota", {"businessMaxSharePct": 90, "spotMinFreeRamPct": 50}),
    }


def tick(config: dict[str, Any], poll_threads: bool = True) -> dict[str, Any]:
    hub_url = config["hubUrl"].rstrip("/")
    token = config["token"]
    hb = build_heartbeat(config, include_threads=poll_threads)
    resp = http_json(f"{hub_url}/api/nodes/heartbeat", token, method="POST", payload=hb)

    t3_bin = find_t3_binary(config.get("t3Bin"))
    executed: list[dict[str, Any]] = []
    for cmd in resp.get("pendingCommands", []):
        cmd_id = cmd.get("id")
        if not cmd_id:
            continue
        result = execute_command(t3_bin, cmd, allowed_projects=hb["projects"])
        try:
            http_json(f"{hub_url}/api/commands/{cmd_id}/result", token, method="POST", payload=result)
        except Exception as exc:
            print(f"[{now_iso()}] WARN failed reporting command {cmd_id}: {exc}", file=sys.stderr, flush=True)
        executed.append({"id": cmd_id, "kind": cmd.get("kind"), "ok": result.get("ok")})

    return {
        "heartbeat": {
            "nodeId": hb["nodeId"],
            "ramFreeMb": hb["telemetry"]["ramFreeMb"],
            "activeThreads": hb["telemetry"]["activeThreads"],
            "projects": len(hb["projects"]),
            "threadsObserved": len(hb["threads"]),
            "devices": len(hb["telemetry"]["devices"]),
        },
        "response": resp,
        "executed": executed,
    }


def load_config(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise SystemExit(f"Config not found at {path}. Run `python3 lookout.py init ...` first.")
    return json.loads(path.read_text(encoding="utf-8"))


def default_capabilities_for_role(role: str) -> list[str]:
    if role == "vm":
        return ["small", "slow", "research", "scaffolding", "background"]
    if role == "workstation":
        return ["heavy", "build", "cpu", "memory", "interactive"]
    if role == "device-host":
        return ["mobile", "android", "ios", "small"]
    return ["tiny", "watch", "small"]


def cmd_init(args: argparse.Namespace) -> None:
    cfg_path = Path(args.config).expanduser()
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    node_id = args.node_id or re.sub(r"[^a-z0-9-]+", "-", socket.gethostname().lower()).strip("-")
    caps = (
        [c.strip() for c in args.capabilities.split(",") if c.strip()]
        if args.capabilities
        else default_capabilities_for_role(args.role)
    )
    scan_dirs = [d.strip() for d in (args.scan_dirs or "").split(",") if d.strip()]
    if not scan_dirs:
        for candidate in ("projects", "code", "src", "lc"):
            cand_dir = Path.home() / candidate
            if cand_dir.is_dir():
                scan_dirs.append(str(cand_dir))
                break

    default_projects: list[dict[str, str]] = []
    scratch_dir = Path.home() / ".t3" / "scratch"
    if scratch_dir.is_dir():
        default_projects.append({"title": "No project", "path": str(scratch_dir)})

    config = {
        "hubUrl": args.hub.rstrip("/"),
        "token": args.token,
        "nodeId": node_id,
        "name": args.name or socket.gethostname(),
        "role": args.role,
        "owner": args.owner,
        "environmentId": read_t3_environment_id(),
        "capabilities": caps,
        "maxSlots": args.max_slots,
        "intervalSeconds": args.interval,
        "scanDirs": scan_dirs,
        "projects": default_projects,
        "probeDevices": True,
        "quota": {"businessMaxSharePct": 90, "spotMinFreeRamPct": 50},
    }
    cfg_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    try:
        os.chmod(cfg_path, 0o600)
    except OSError:
        pass
    print(f"Wrote Lookout config to {cfg_path} (nodeId={node_id}, role={args.role}, scanDirs={scan_dirs})")


def cmd_once(args: argparse.Namespace) -> None:
    config = load_config(Path(args.config).expanduser())
    out = tick(config, poll_threads=not args.no_threads)
    print(json.dumps(out, indent=2))


def cmd_status(args: argparse.Namespace) -> None:
    config = load_config(Path(args.config).expanduser())
    hb = build_heartbeat(config, include_threads=not args.no_threads)
    print(json.dumps(hb, indent=2))


def cmd_run(args: argparse.Namespace) -> None:
    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)
    config = load_config(Path(args.config).expanduser())
    interval = max(5, int(config.get("intervalSeconds", 20)))
    backoff = 0

    print(
        f"[{now_iso()}] Lookout starting: nodeId={config['nodeId']} role={config.get('role')} hub={config['hubUrl']} interval={interval}s",
        flush=True,
    )
    while RUNNING:
        try:
            res = tick(config, poll_threads=True)
            backoff = 0
            ev_count = res["response"].get("eventsRecorded", 0)
            exec_count = len(res["executed"])
            if ev_count or exec_count:
                print(
                    f"[{now_iso()}] tick ok: ramFree={res['heartbeat']['ramFreeMb']}MB active={res['heartbeat']['activeThreads']} events={ev_count} cmds={exec_count}",
                    flush=True,
                )
        except urllib.error.HTTPError as exc:
            backoff = min(120, (backoff * 2) if backoff else 10)
            print(f"[{now_iso()}] HTTP {exc.code} from Hub; retrying in {backoff}s", file=sys.stderr, flush=True)
        except Exception as exc:
            backoff = min(120, (backoff * 2) if backoff else 10)
            print(f"[{now_iso()}] tick error: {exc}; retrying in {backoff}s", file=sys.stderr, flush=True)

        sleep_for = backoff or interval
        deadline = time.monotonic() + sleep_for
        while RUNNING and time.monotonic() < deadline:
            time.sleep(min(1.0, max(0.1, deadline - time.monotonic())))

    print(f"[{now_iso()}] Lookout stopped cleanly.", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(prog="lookout", description="Flagship Lookout node agent")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG_PATH), help="Path to lookout.json")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_init = sub.add_parser("init", help="Create ~/.flagship/lookout.json")
    p_init.add_argument("--hub", required=True, help="Flagship Hub base URL")
    p_init.add_argument("--token", required=True, help="Flagship Bearer token")
    p_init.add_argument("--node-id", help="Unique node ID (default: hostname)")
    p_init.add_argument("--name", help="Human-friendly node name")
    p_init.add_argument("--role", choices=["vm", "workstation", "tiny", "device-host"], default="vm")
    p_init.add_argument("--owner", default=getpass.getuser())
    p_init.add_argument("--capabilities", help="Comma-separated capabilities")
    p_init.add_argument("--max-slots", type=int, default=4)
    p_init.add_argument("--interval", type=int, default=20)
    p_init.add_argument("--scan-dirs", help="Comma-separated directories containing git projects")
    p_init.set_defaults(func=cmd_init)

    p_once = sub.add_parser("once", help="Send one heartbeat and process pending commands")
    p_once.add_argument("--no-threads", action="store_true")
    p_once.set_defaults(func=cmd_once)

    p_status = sub.add_parser("status", help="Print local telemetry snapshot without sending")
    p_status.add_argument("--no-threads", action="store_true")
    p_status.set_defaults(func=cmd_status)

    p_run = sub.add_parser("run", help="Run Lookout continuously")
    p_run.set_defaults(func=cmd_run)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
