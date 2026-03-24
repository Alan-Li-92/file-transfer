#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="file-transfer.service"
TARGET_PATH="/etc/systemd/system/${SERVICE_NAME}"

sudo cp "/home/alan/file-transfer/file-transfer-system.service" "${TARGET_PATH}"
sudo systemctl daemon-reload
sudo systemctl enable --now "${SERVICE_NAME}"

echo "System service installed and started."
echo "Check status with: sudo systemctl status ${SERVICE_NAME}"
echo "View logs with: sudo journalctl -u ${SERVICE_NAME} -f"
