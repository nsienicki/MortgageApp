#!/usr/bin/env bash
# Runs on the server, called by upload.ps1. Unpacks the uploaded code into /opt/homebuyer-lens/app and,
# if the site is already set up, updates packages and restarts it.
set -euo pipefail
SUDO=""
[[ $(id -u) -eq 0 ]] || SUDO=sudo
BASE=/opt/homebuyer-lens
TARBALL=/tmp/homebuyer-lens.tar.gz

$SUDO rm -rf "$BASE/app.new"
$SUDO mkdir -p "$BASE/app.new"
$SUDO tar -xzf "$TARBALL" -C "$BASE/app.new"
# Files edited on Windows may have CRLF line endings, which break bash and systemd.
$SUDO find "$BASE/app.new" -type f \( -name '*.sh' -o -name '*.service' -o -name '*.timer' -o -name '*.conf' \) \
  -exec sed -i 's/\r$//' {} +
$SUDO chown -R root:root "$BASE/app.new"
$SUDO chmod -R a+rX "$BASE/app.new"

# Swap the new code in, keeping the previous version for a quick rollback.
$SUDO rm -rf "$BASE/app.previous"
if [[ -d "$BASE/app" ]]; then $SUDO mv "$BASE/app" "$BASE/app.previous"; fi
$SUDO mv "$BASE/app.new" "$BASE/app"
rm -f "$TARBALL"

if [[ -f /etc/systemd/system/homebuyer-lens.service && -x "$BASE/venv/bin/pip" ]]; then
  $SUDO "$BASE/venv/bin/pip" install -q -r "$BASE/app/requirements.txt"
  $SUDO cp "$BASE/app/deploy/homebuyer-lens.service" "$BASE/app/deploy/homebuyer-lens-ingest.service" \
           "$BASE/app/deploy/homebuyer-lens-ingest.timer" /etc/systemd/system/
  $SUDO systemctl daemon-reload
  $SUDO systemctl restart homebuyer-lens
  for _ in {1..15}; do
    if curl -fsS http://127.0.0.1:8000/healthz; then echo "  <- site is up with the new code"; exit 0; fi
    sleep 2
  done
  echo "The site didn't come back. Check: journalctl -u homebuyer-lens -n 50"
  echo "To roll back: mv $BASE/app $BASE/app.failed && mv $BASE/app.previous $BASE/app && systemctl restart homebuyer-lens"
  exit 1
else
  echo "Code uploaded to $BASE/app."
  echo "First time? Run:  bash $BASE/app/deploy/setup_server.sh <your-domain> <your-email>"
fi
