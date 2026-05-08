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
install -d -o kamal -g kamal -m 0755 "$HOMEDIR/.config"
install -d -o kamal -g kamal -m 0755 "$HOMEDIR/.config/Ultralytics"

echo "== 3/5 venv + pip install (this is slow first time, torch is ~700MB)"
if [ ! -d "$SVC/.venv" ]; then
  sudo -u kamal python3 -m venv "$SVC/.venv"
fi
sudo -u kamal "$SVC/.venv/bin/pip" install --upgrade pip wheel >/dev/null
sudo -u kamal "$SVC/.venv/bin/pip" install -r "$SVC/requirements.txt"

# Pre-download the YOLOv8n weights to a writable absolute path.
# Required because ProtectSystem=strict makes the deploy dir read-only,
# and ultralytics' default behavior is to download bare filenames into
# the CWD. Writing to $HOMEDIR/yolov8n.pt at install time means the first
# service start has nothing to fetch and comes up in seconds, not minutes.
WEIGHTS="$HOMEDIR/yolov8n.pt"
if [ ! -f "$WEIGHTS" ]; then
  echo "== 3.5/5 pre-download yolov8n.pt"
  curl -fsSL --retry 3 --max-time 120 -o "$WEIGHTS.tmp" \
    "https://github.com/ultralytics/assets/releases/download/v8.4.0/yolov8n.pt"
  chown kamal:kamal "$WEIGHTS.tmp"
  mv "$WEIGHTS.tmp" "$WEIGHTS"
  ls -la "$WEIGHTS"
else
  echo "== 3.5/5 yolov8n.pt already cached at $WEIGHTS"
fi

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
# Up to 180s — first run JIT-compiles torch ops on cold CPU. Subsequent
# restarts are <10s because torch's compile cache + the pre-downloaded
# weights are both warm.
for i in {1..60}; do
  if curl -sf --max-time 5 http://127.0.0.1:8766/health >/tmp/wd-health.json 2>/dev/null; then
    cat /tmp/wd-health.json | python3 -m json.tool
    break
  fi
  echo "    waiting for health... ($i/60)"
  sleep 3
done
if [ ! -s /tmp/wd-health.json ]; then
  echo "WARNING: /health did not respond. Showing last 20 journal lines:"
  journalctl -u weapon-detector -n 20 --no-pager
fi
