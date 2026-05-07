#!/usr/bin/env bash
# One-shot installer for the face-embedder sidecar on the production VPS.
#
# Idempotent: re-running just upgrades pip deps and restarts the service.
#
# Run on the prod box as the kamal user. Needs sudo for systemd + apt:
#   sudo bash services/face-embedder/install.sh
set -euo pipefail

SVC=/var/www/odyn-aware/current/services/face-embedder
HOMEDIR=/var/lib/auroraview-face-embedder
UNIT=/etc/systemd/system/face-embedder.service

echo "== 1/5 apt: python3-venv (idempotent)"
apt-get install -y python3-venv python3-pip libgomp1 >/dev/null

echo "== 2/5 home dir for InsightFace model cache"
install -d -o kamal -g kamal -m 0755 "$HOMEDIR"
install -d -o kamal -g kamal -m 0755 "$HOMEDIR/.insightface"

echo "== 3/5 venv + pip install"
if [ ! -d "$SVC/.venv" ]; then
  sudo -u kamal python3 -m venv "$SVC/.venv"
fi
sudo -u kamal "$SVC/.venv/bin/pip" install --upgrade pip wheel >/dev/null
sudo -u kamal "$SVC/.venv/bin/pip" install -r "$SVC/requirements.txt"

echo "== 4/5 systemd unit"
install -m 0644 "$SVC/face-embedder.service" "$UNIT"
systemctl daemon-reload
systemctl enable face-embedder

echo "== 5/5 (re)start"
systemctl restart face-embedder
sleep 3
systemctl status face-embedder --no-pager -l | head -n 15

echo
echo "== smoke test /health"
curl -sS --max-time 30 http://127.0.0.1:8765/health | python3 -m json.tool
