#!/usr/bin/env bash
set -euo pipefail

SERVICE_DIR="${HOME}/.config/systemd/user"
SERVICE_NAME="file-transfer.service"

mkdir -p "${SERVICE_DIR}"
cp "/home/alan/file-transfer/${SERVICE_NAME}" "${SERVICE_DIR}/${SERVICE_NAME}"

systemctl --user daemon-reload
systemctl --user enable --now "${SERVICE_NAME}"

echo "Service installed and started."
echo "Check status with: systemctl --user status ${SERVICE_NAME}"
echo "View logs with: journalctl --user -u ${SERVICE_NAME} -f"
