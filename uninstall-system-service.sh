#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="file-transfer.service"
TARGET_PATH="/etc/systemd/system/${SERVICE_NAME}"

sudo systemctl disable --now "${SERVICE_NAME}" 2>/dev/null || true
sudo rm -f "${TARGET_PATH}"
sudo systemctl daemon-reload

echo "System service removed."
