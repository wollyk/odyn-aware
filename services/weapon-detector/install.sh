#!/usr/bin/env bash
# One-shot installer for the weapon-detector sidecar on the production VPS.
#
# Idempotent: re-running just upgrades pip deps and restarts the service.
#
# Run on the prod box as root (or sudo):
#   sudo bash services/weapon-detector/install.sh
set -euo pipefail

SVC=/var/www/odyn-aware/current/services/weapon-detector
HOMEDIR=/var/lib/auroraview-weapon-detector
UNIT=/etc/systemd/system/weapon-detector.service

echo "== 1/5 apt: python3-venv + libgomp1 (idempotent)"
apt-get install -y python3-venv python3-pip libgomp1 libgl1 libglib2.0-0 >/dev/null

echo "== 2/5 home dir for ultralytics weight cache"
install -d -o kamal -g kamal -m 0755 "$HOMEDIR"
install -d -o kamal -g kamal -m 0755 "$HOMEDIR/.cache"

echo "== 3/5 venv + pip install (this is slow first time, torch is ~700MB)"
if [ ! -d "$SVC/.venv" ]; then
  sudo -u kamal python3 -m venv "$SVC/.venv"
fi
sudo -u kamal "$SVC/.venv/bin/pip" install --upgrade pip wheel >/dev/null
sudo -u kamal "$SVC/.venv/bin/pip" install -r "$SVC/requirements.txt"

echo "== 4/5 systemd unit"
install -m 0644 "$SVC/weapon-detector.service" "$UNIT"
systemctl daemon-reload
systemctl enable weapon-detector

echo "== 5/5 (re)start"
systemctl restart weapon-detector
sleep 5
systemctl status weapon-detector --no-pager -l | head -n 18

echo
echo "== smoke test /health"
# Up to 60s — first run downloads weights and JIT-compiles torch ops.
for i in {1..30}; do
  if curl -sf --max-time 5 http://127.0.0.1:8766/health >/tmp/wd-health.json; then
    cat /tmp/wd-health.json | python3 -m json.tool
    break
  fi
  echo "    waiting for health... ($i/30)"
  sleep 2
done
