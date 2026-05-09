#!/usr/bin/env bash
# One-shot installer for the tracker sidecar (YOLOv8s + ByteTrack).
#
# Idempotent: re-running upgrades pip deps + restarts the service.
#
# Run on the prod box as root (or sudo):
#   sudo bash services/tracker/install.sh
set -euo pipefail

SVC=/var/www/odyn-aware/current/services/tracker
HOMEDIR=/var/lib/auroraview-tracker
UNIT=/etc/systemd/system/tracker.service

echo "== 1/5 apt: python3-venv + libgomp1/libgl1 (idempotent)"
apt-get install -y python3-venv python3-pip libgomp1 libgl1 libglib2.0-0 >/dev/null

echo "== 2/5 home dir for ultralytics weight cache"
install -d -o kamal -g kamal -m 0755 "$HOMEDIR"
install -d -o kamal -g kamal -m 0755 "$HOMEDIR/.cache"
install -d -o kamal -g kamal -m 0755 "$HOMEDIR/.config"
install -d -o kamal -g kamal -m 0755 "$HOMEDIR/.config/Ultralytics"

echo "== 3/5 venv + pip install"
if [ ! -d "$SVC/.venv" ]; then
  sudo -u kamal python3 -m venv "$SVC/.venv"
fi
sudo -u kamal "$SVC/.venv/bin/pip" install --upgrade pip wheel >/dev/null
sudo -u kamal "$SVC/.venv/bin/pip" install -r "$SVC/requirements.txt"

# Pre-download YOLOv8s (~22MB). Same reason as weapon-detector: deploy dir
# is read-only under ProtectSystem=strict, and ultralytics tries to
# download bare filenames into the CWD on first run.
WEIGHTS="$HOMEDIR/yolov8s.pt"
if [ ! -f "$WEIGHTS" ]; then
  echo "== 3.5/5 pre-download yolov8s.pt"
  curl -fsSL --retry 3 --max-time 180 -o "$WEIGHTS.tmp" \
    "https://github.com/ultralytics/assets/releases/download/v8.4.0/yolov8s.pt"
  chown kamal:kamal "$WEIGHTS.tmp"
  mv "$WEIGHTS.tmp" "$WEIGHTS"
  ls -la "$WEIGHTS"
else
  echo "== 3.5/5 yolov8s.pt already cached at $WEIGHTS"
fi

echo "== 4/5 systemd unit"
install -m 0644 "$SVC/tracker.service" "$UNIT"
systemctl daemon-reload
systemctl enable tracker

echo "== 5/5 (re)start"
systemctl restart tracker
sleep 5
systemctl status tracker --no-pager -l | head -n 18

echo
echo "== smoke test /health (up to 180s for first cold start)"
for i in {1..60}; do
  if curl -sf --max-time 5 http://127.0.0.1:8767/health >/tmp/tracker-health.json 2>/dev/null; then
    cat /tmp/tracker-health.json | python3 -m json.tool
    break
  fi
  echo "    waiting for health... ($i/60)"
  sleep 3
done
if [ ! -s /tmp/tracker-health.json ]; then
  echo "WARNING: /health did not respond. Showing last 30 journal lines:"
  journalctl -u tracker -n 30 --no-pager
fi
