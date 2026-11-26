# Executive Overview API Contract (`GET /api/overview`)

Designed for any external executive dashboard or container app to display a calm C-level view over dozens of T3 threads across all your machines.

## Request

```http
GET https://<flagship-hub>/api/overview
Authorization: Bearer <FLAGSHIP_TOKEN>
```

> **Browser dashboards:** If a browser SPA fetches `/api/overview` directly from another origin, set `CORS_ORIGIN` in `hub/wrangler.jsonc` (or Worker env vars) to your dashboard's exact origin (e.g. `https://dashboard.example.com`). Prefer proxying through your dashboard backend so `FLAGSHIP_TOKEN` never sits in browser client code.

## Response Shape

```json
{
  "generatedAt": "2026-11-26T01:00:00.000Z",
  "standDown": false,
  "standDownReason": null,
  "counts": {
    "nodesOnline": 2,
    "nodesTotal": 2,
    "threadsActive": 3,
    "needsAttention": 1,
    "ideasInbox": 5,
    "pendingCommands": 0,
    "openAlerts": 0
  },
  "nodes": [
    {
      "nodeId": "cloud-vm",
      "name": "Cloud VM",
      "role": "vm",
      "status": "online",
      "telemetry": {
        "ramTotalMb": 16002,
        "ramFreeMb": 7800,
        "ramUsedPct": 51,
        "cpuCores": 4,
        "load1m": 0.9,
        "diskFreeGb": 33.2,
        "activeThreads": 2,
        "maxSlots": 6,
        "devices": []
      }
    }
  ],
  "needsAttention": [],
  "inFlight": [],
  "ideas": [],
  "openAlerts": [],
  "recentEvents": [],
  "rebalanceSuggestions": []
}
```
