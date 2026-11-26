#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_BIN="$(command -v python3)"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/flagship-lookout.service"

mkdir -p "$SERVICE_DIR"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Flagship Lookout (zero-token machine watcher)
After=network-online.target

[Service]
Type=simple
ExecStart=${PYTHON_BIN} ${SCRIPT_DIR}/lookout.py run
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now flagship-lookout.service
systemctl --user status flagship-lookout.service --no-pager -l | head -n 20
