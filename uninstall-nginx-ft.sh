#!/usr/bin/env bash
set -euo pipefail

SITE_CONF="/etc/nginx/conf.d/code.allicn.top.conf"
LOCATION_CONF="/etc/nginx/file-transfer.location.inc"
BACKUP_CONF="/etc/nginx/conf.d/code.allicn.top.conf.bak.file-transfer"
INCLUDE_LINE="    include /etc/nginx/file-transfer.location.inc;"

if sudo test -f "${BACKUP_CONF}"; then
  sudo cp "${BACKUP_CONF}" "${SITE_CONF}"
else
  sudo perl -0pi -e 's@\n\n    include /etc/nginx/file-transfer.location.inc;\n@@' "${SITE_CONF}" || true
fi

sudo rm -f "${LOCATION_CONF}"
sudo nginx -t
sudo systemctl reload nginx

echo "Removed /ft nginx route."
