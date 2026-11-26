#!/usr/bin/env python3
"""
Helm CLI — thin executive command-line client for Flagship Hub.
Zero dependencies (Python 3 stdlib only). Reads hubUrl & token from
~/.flagship/lookout.json (or FLAGSHIP_HUB_URL / FLAGSHIP_TOKEN env vars).
"""

from __future__ import annotations

import argparse
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_CONFIG_PATH = Path.home() / ".flagship" / "lookout.json"


def _build_ssl_context() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    if not ctx.get_ca_certs() and Path("/etc/ssl/cert.pem").exists():
        ctx.load_verify_locations(cafile="/etc/ssl/cert.pem")
    return ctx


def load_auth(config_path: str) -> tuple[str, str]:
    hub = os.environ.get("FLAGSHIP_HUB_URL", "").strip()
    token = os.environ.get("FLAGSHIP_TOKEN", "").strip()
    if not (hub and token):
        p = Path(config_path).expanduser()
        if p.exists():
            cfg = json.loads(p.read_text(encoding="utf-8"))
            hub = hub or str(cfg.get("hubUrl", "")).strip()
            token = token or str(cfg.get("token", "")).strip()
    if not hub or not token:
        raise SystemExit(
            f"Missing Hub URL/token. Set FLAGSHIP_HUB_URL & FLAGSHIP_TOKEN or initialize {config_path}."
        )
    return hub.rstrip("/"), token


def api(hub: str, token: str, path: str, method: str = "GET", payload: dict[str, Any] | None = None) -> Any:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        f"{hub}{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "flagship-helm/0.1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20, context=_build_ssl_context()) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"HTTP {exc.code}: {body}") from exc


def print_overview(data: dict[str, Any]) -> None:
    banner = "STAND-DOWN" if data.get("standDown") else "ACTIVE"
    counts = data.get("counts", {})
    print(f"=== FLAGSHIP OVERVIEW [{banner}] ===")
    if data.get("standDown") and data.get("standDownReason"):
        print(f"Paused: {data['standDownReason']}")
    if data.get("storageDegraded"):
        warn = data.get("storageWarning") or "Hub storage temporarily degraded; showing live in-memory fleet state."
        print(f"Warning: {warn}")
    print(
        f"Nodes: {counts.get('nodesOnline', 0)}/{counts.get('nodesTotal', 0)} online | "
        f"Active threads: {counts.get('threadsActive', 0)} | "
        f"Needs attention: {counts.get('needsAttention', 0)} | "
        f"Open alerts: {counts.get('openAlerts', 0)} | "
        f"Ideas inbox: {counts.get('ideasInbox', 0)}"
    )
    print("\n-- Machines --")
    for n in data.get("nodes", []):
        t = n.get("telemetry", {})
        devs = t.get("devices") or []
        dev_str = f" | devices: {', '.join(d['name'] for d in devs)}" if devs else ""
        print(
            f"  [{n['status']:7}] {n['name']} ({n['nodeId']}, role={n['role']}) "
            f"RAM {t.get('ramFreeMb', 0)}/{t.get('ramTotalMb', 0)}MB free | "
            f"CPU load {t.get('load1m', 0)}/{t.get('cpuCores', 0)}c | "
            f"slots {t.get('activeThreads', 0)}/{t.get('maxSlots', 0)}{dev_str}"
        )

    attn = data.get("needsAttention", [])
    if attn:
        print("\n-- Needs Attention --")
        for th in attn:
            tag = "STALLED" if th.get("stalled") else th.get("status", "").upper()
            link = f" -> {th['link']}" if th.get("link") else ""
            print(f"  [{tag}] [{th['nodeId']}] {th['title']}{link}")

    alerts = data.get("openAlerts", [])
    if alerts:
        print("\n-- Open Alerts --")
        for a in alerts:
            repo = f" ({a['repo']})" if a.get("repo") else ""
            hits = f" [x{a['hitCount']}]" if a.get("hitCount", 1) > 1 else ""
            link = f" -> {a['threadLink']}" if a.get("threadLink") else ""
            print(
                f"  [{a.get('status', 'open').upper()}] [{a.get('severity', 'ops')}] "
                f"{a['alertKey']}{repo}{hits}: {a.get('summary', '')}{link}"
            )

    inflight = data.get("inFlight", [])
    if inflight:
        print("\n-- In Flight --")
        for th in inflight:
            link = f" -> {th['link']}" if th.get("link") else ""
            print(f"  [{th['status']}] [{th['nodeId']}] {th['title']}{link}")

    sugg = data.get("rebalanceSuggestions", [])
    if sugg:
        print("\n-- Rebalance / Efficiency Suggestions --")
        for s in sugg:
            print(f"  [{s['severity'].upper()}] {s['message']}")

    ideas = [i for i in data.get("ideas", []) if i.get("status") in ("inbox", "planned")]
    if ideas:
        print("\n-- Open Ideas / Backlog --")
        for i in ideas[:10]:
            proj = f" ({i['project']})" if i.get("project") else ""
            print(f"  [{i['priority']}] [{i['status']}] [{i['workload']}] {i['id']}: {i['title']}{proj}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="helm", description="Flagship Helm executive CLI")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG_PATH))
    parser.add_argument("--json", action="store_true", dest="as_json")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_ov = sub.add_parser("overview", help="Show C-level executive fleet overview")
    p_ov.add_argument("--json", action="store_true", dest="ov_json")

    p_route = sub.add_parser("route", help="Dry-run auto-routing for a task")
    p_route.add_argument("title")
    p_route.add_argument("--description", default="")
    p_route.add_argument("--workload", default="auto")
    p_route.add_argument("--project")
    p_route.add_argument("--node", dest="preferred_node")
    p_route.add_argument("--device", choices=["android", "ios"])

    p_disp = sub.add_parser("dispatch", help="Auto-route and launch a worker thread")
    p_disp.add_argument("title")
    p_disp.add_argument("--prompt", help="Detailed prompt for worker (defaults to title)")
    p_disp.add_argument("--project")
    p_disp.add_argument("--workload", default="auto")
    p_disp.add_argument("--node", dest="preferred_node")
    p_disp.add_argument("--worktree")
    p_disp.add_argument("--branch")
    p_disp.add_argument("--provider")
    p_disp.add_argument("--model")
    p_disp.add_argument("--idea-id")
    p_disp.add_argument("--mode", choices=["lookout", "plan"], default="lookout")

    p_send = sub.add_parser("send", help="Send a follow-up message to a thread on a node")
    p_send.add_argument("node_id")
    p_send.add_argument("thread_id")
    p_send.add_argument("message")

    p_dismiss = sub.add_parser("dismiss", help="Dismiss stale failed or attention threads from overview")
    p_dismiss.add_argument("thread_id", nargs="?", help="Specific thread ID to dismiss")
    p_dismiss.add_argument("--all-failed", action="store_true", help="Dismiss all failed/interrupted threads")
    p_dismiss.add_argument("--node", dest="node_id", help="Optional node ID to scope thread dismissal")

    p_idea = sub.add_parser("idea", help="Manage idea backlog")
    idea_sub = p_idea.add_subparsers(dest="idea_cmd", required=True)
    p_idea_add = idea_sub.add_parser("add")
    p_idea_add.add_argument("title")
    p_idea_add.add_argument("--notes", default="")
    p_idea_add.add_argument("--priority", choices=["P0", "P1", "P2", "P3"], default="P2")
    p_idea_add.add_argument("--workload", default="auto")
    p_idea_add.add_argument("--project")
    p_idea_add.add_argument("--visibility", choices=["business", "public", "private-spot"], default="business")

    idea_sub.add_parser("list")

    p_idea_upd = idea_sub.add_parser("update")
    p_idea_upd.add_argument("id")
    p_idea_upd.add_argument("--priority", choices=["P0", "P1", "P2", "P3"])
    p_idea_upd.add_argument("--status", choices=["inbox", "planned", "dispatched", "done", "parked"])
    p_idea_upd.add_argument("--notes")
    p_idea_upd.add_argument("--node", dest="assigned_node")
    p_idea_upd.add_argument("--thread-id")
    p_idea_upd.add_argument("--thread-link")

    p_alert = sub.add_parser("alert", help="Manage proactive Discord/ops alerts")
    alert_sub = p_alert.add_subparsers(dest="alert_cmd", required=True)
    p_alert_list = alert_sub.add_parser("list", help="List open/working alerts (or --all)")
    p_alert_list.add_argument("--all", action="store_true", dest="show_all", help="Include resolved/closed alerts")

    p_alert_upd = alert_sub.add_parser("update", help="Update alert status and flip Discord reaction")
    p_alert_upd.add_argument("alert_key")
    p_alert_upd.add_argument(
        "--status",
        required=True,
        choices=["open", "working", "resolved", "false_positive", "wontfix"],
    )
    p_alert_upd.add_argument("--thread-id")
    p_alert_upd.add_argument("--thread-link")
    p_alert_upd.add_argument("--note")

    p_sd = sub.add_parser("stand-down", help="Hard pause Flagship wakeups & auto-dispatch")
    p_sd.add_argument("reason", nargs="?", default="Paused by operator")

    sub.add_parser("resume", help="Resume Flagship")

    p_ev = sub.add_parser("events", help="List recent fleet events")
    p_ev.add_argument("--limit", type=int, default=20)

    p_wh = sub.add_parser("webhook", help="Configure Helm T3 wakeup webhook")
    wh_sub = p_wh.add_subparsers(dest="wh_cmd", required=True)
    p_wh_set = wh_sub.add_parser("set")
    p_wh_set.add_argument("url")
    p_wh_set.add_argument("--secret", default="")
    p_wh_set.add_argument("--thread-id", dest="thread_id", default=None, help="Helm Home thread ID (suppresses self-wakeups)")
    wh_sub.add_parser("test")

    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.cmd == "dismiss" and not args.all_failed and not args.thread_id:
        parser.error("Provide <thread_id> or --all-failed")

    hub, token = load_auth(args.config)

    if args.cmd == "overview":
        data = api(hub, token, "/api/overview")
        if args.as_json or getattr(args, "ov_json", False):
            print(json.dumps(data, indent=2))
        else:
            print_overview(data)
    elif args.cmd == "route":
        payload = {
            "title": args.title,
            "description": args.description,
            "workload": args.workload,
            "project": args.project,
            "preferredNode": args.preferred_node,
            "requireDevice": args.device,
        }
        print(json.dumps(api(hub, token, "/api/route", "POST", payload), indent=2))
    elif args.cmd == "dispatch":
        payload = {
            "title": args.title,
            "prompt": args.prompt or args.title,
            "project": args.project,
            "workload": args.workload,
            "preferredNode": args.preferred_node,
            "worktree": args.worktree,
            "branch": args.branch,
            "provider": args.provider,
            "model": args.model,
            "ideaId": args.idea_id,
            "mode": args.mode,
        }
        print(json.dumps(api(hub, token, "/api/dispatch", "POST", payload), indent=2))
    elif args.cmd == "send":
        payload = {"nodeId": args.node_id, "threadId": args.thread_id, "message": args.message}
        print(json.dumps(api(hub, token, "/api/threads/send", "POST", payload), indent=2))
    elif args.cmd == "dismiss":
        if args.all_failed:
            payload: dict[str, Any] = {"allFailed": True}
        else:
            payload = {"threadId": args.thread_id}
            if args.node_id:
                payload["nodeId"] = args.node_id
        print(json.dumps(api(hub, token, "/api/threads/dismiss", "POST", payload), indent=2))
    elif args.cmd == "idea":
        if args.idea_cmd == "add":
            payload = {
                "title": args.title,
                "notes": args.notes,
                "priority": args.priority,
                "workload": args.workload,
                "project": args.project,
                "visibility": args.visibility,
            }
            print(json.dumps(api(hub, token, "/api/ideas", "POST", payload), indent=2))
        elif args.idea_cmd == "list":
            print(json.dumps(api(hub, token, "/api/ideas"), indent=2))
        elif args.idea_cmd == "update":
            payload = {
                k: v
                for k, v in {
                    "priority": args.priority,
                    "status": args.status,
                    "notes": args.notes,
                    "assignedNode": args.assigned_node,
                    "threadId": args.thread_id,
                    "threadLink": args.thread_link,
                }.items()
                if v is not None
            }
            print(json.dumps(api(hub, token, f"/api/ideas/{args.id}", "PATCH", payload), indent=2))
    elif args.cmd == "alert":
        if args.alert_cmd == "list":
            path = "/api/alerts?status=all" if args.show_all else "/api/alerts"
            print(json.dumps(api(hub, token, path), indent=2))
        elif args.alert_cmd == "update":
            payload = {
                k: v
                for k, v in {
                    "status": args.status,
                    "threadId": args.thread_id,
                    "threadLink": args.thread_link,
                    "note": args.note,
                }.items()
                if v is not None
            }
            encoded_key = urllib.parse.quote(args.alert_key, safe="")
            print(json.dumps(api(hub, token, f"/api/alerts/{encoded_key}", "PATCH", payload), indent=2))
    elif args.cmd == "stand-down":
        print(json.dumps(api(hub, token, "/api/control/stand-down", "POST", {"reason": args.reason}), indent=2))
    elif args.cmd == "resume":
        print(json.dumps(api(hub, token, "/api/control/resume", "POST", {}), indent=2))
    elif args.cmd == "events":
        print(json.dumps(api(hub, token, f"/api/events?limit={args.limit}"), indent=2))
    elif args.cmd == "webhook":
        if args.wh_cmd == "set":
            wh_payload: dict[str, Any] = {"url": args.url, "secret": args.secret}
            if args.thread_id is not None:
                wh_payload["threadId"] = args.thread_id
            print(
                json.dumps(
                    api(hub, token, "/api/control/webhook", "POST", wh_payload),
                    indent=2,
                )
            )
        elif args.wh_cmd == "test":
            print(json.dumps(api(hub, token, "/api/control/webhook/test", "POST", {}), indent=2))


if __name__ == "__main__":
    main()
