#!/usr/bin/env bash
set -euo pipefail

SITE_CONF="/etc/nginx/conf.d/code.allicn.top.conf"
LOCATION_CONF="/etc/nginx/file-transfer.location.inc"
SOURCE_LOCATION_CONF="/home/alan/file-transfer/nginx/file-transfer.location.conf"
BACKUP_CONF="/etc/nginx/conf.d/code.allicn.top.conf.bak.file-transfer"
INCLUDE_LINE="    include /etc/nginx/file-transfer.location.inc;"

if [[ ! -f "${SITE_CONF}" ]]; then
  echo "Site config not found: ${SITE_CONF}" >&2
  exit 1
fi

sudo cp "${SITE_CONF}" "${BACKUP_CONF}"
sudo cp "${SOURCE_LOCATION_CONF}" "${LOCATION_CONF}"

if ! sudo grep -Fq "${INCLUDE_LINE}" "${SITE_CONF}"; then
  sudo perl -0pi -e 's@\n\s*location / \{@\n\n    include /etc/nginx/file-transfer.location.inc;\n\n    location / {@' "${SITE_CONF}"
fi

sudo nginx -t
sudo systemctl reload nginx

echo "Installed /ft nginx route."
echo "Site config: ${SITE_CONF}"
echo "Location config: ${LOCATION_CONF}"
echo "Backup saved to: ${BACKUP_CONF}"
