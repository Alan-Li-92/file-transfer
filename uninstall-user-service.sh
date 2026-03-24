#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="file-transfer.service"
SERVICE_PATH="${HOME}/.config/systemd/user/${SERVICE_NAME}"

systemctl --user disable --now "${SERVICE_NAME}" 2>/dev/null || true
rm -f "${SERVICE_PATH}"
systemctl --user daemon-reload

echo "Service removed."
