#!/usr/bin/env bash
# One-time setup of Homebuyer Market Lens on a fresh Ubuntu server (IONOS VPS or Cloud Server).
# Run as root after upload.ps1 has copied the app to /opt/homebuyer-lens/app:
#
#   bash /opt/homebuyer-lens/app/deploy/setup_server.sh example.com you@example.com
#
# Safe to re-run: every step checks or overwrites its own result.
set -euo pipefail

DOMAIN="${1:?Usage: setup_server.sh <domain> <email for HTTPS certificate notices>}"
EMAIL="${2:?Usage: setup_server.sh <domain> <email for HTTPS certificate notices>}"
APP_DIR=/opt/homebuyer-lens
CODE="$APP_DIR/app"
DATA_DIR=/var/lib/homebuyer-lens
ENV_FILE=/etc/homebuyer-lens.env

[[ $EUID -eq 0 ]] || { echo "Run this as root (or with sudo)."; exit 1; }
[[ -f "$CODE/server.py" ]] || { echo "No app found in $CODE. Run deploy/upload.ps1 from your PC first."; exit 1; }

step() { echo; echo "==> $*"; }

step "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q python3 python3-venv nginx certbot python3-certbot-nginx ufw

step "Creating the service account and folders"
id lens &>/dev/null || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin lens
mkdir -p "$DATA_DIR"
chown -R lens:lens "$DATA_DIR"
chown -R root:root "$CODE"          # the app can read its code but not change it
chmod -R a+rX "$CODE"

step "Installing Python packages"
[[ -x "$APP_DIR/venv/bin/python" ]] || python3 -m venv "$APP_DIR/venv"
"$APP_DIR/venv/bin/pip" install -q --upgrade pip
"$APP_DIR/venv/bin/pip" install -q -r "$CODE/requirements.txt"

step "Writing settings to $ENV_FILE"
if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<EOF
LENS_DATA_DIR=$DATA_DIR
LENS_DB_PATH=$DATA_DIR/housing.duckdb
# Cap memory while the weekly refresh builds the database (it peaks around 0.5-1 GB).
LENS_INGEST_MEMORY=1GB
# Optional: free key from https://api.census.gov/data/key_signup.html for metro-level income.
# CENSUS_API_KEY=
EOF
fi
chown root:lens "$ENV_FILE"
chmod 640 "$ENV_FILE"

step "Installing services"
cp "$CODE/deploy/homebuyer-lens.service" "$CODE/deploy/homebuyer-lens-ingest.service" \
   "$CODE/deploy/homebuyer-lens-ingest.timer" /etc/systemd/system/
systemctl daemon-reload

step "Building the database for the first time (downloads about 400 MB; takes a few minutes)"
if [[ ! -f "$DATA_DIR/housing.duckdb" ]]; then
  systemctl start homebuyer-lens-ingest.service
fi
systemctl enable --now homebuyer-lens.service homebuyer-lens-ingest.timer
systemctl restart homebuyer-lens.service

step "Configuring nginx for $DOMAIN"
cp "$CODE/deploy/proxy.conf" /etc/nginx/snippets/homebuyer-lens-proxy.conf
sed "s/DOMAIN_NAME/$DOMAIN/g" "$CODE/deploy/nginx.conf" > /etc/nginx/sites-available/homebuyer-lens
ln -sf /etc/nginx/sites-available/homebuyer-lens /etc/nginx/sites-enabled/homebuyer-lens
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

step "Opening the firewall for SSH, HTTP and HTTPS"
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

step "Checking the app"
for _ in {1..15}; do
  if curl -fsS http://127.0.0.1:8000/healthz; then echo; break; fi
  sleep 2
done

step "Requesting an HTTPS certificate"
domains=(-d "$DOMAIN")
if getent hosts "www.$DOMAIN" >/dev/null; then domains+=(-d "www.$DOMAIN"); fi
if certbot --nginx "${domains[@]}" --non-interactive --agree-tos -m "$EMAIL" --redirect; then
  echo "HTTPS is set up. Certificates renew automatically."
else
  echo
  echo "Couldn't get a certificate yet. This usually means DNS for $DOMAIN doesn't point to this server yet."
  echo "Once it does, run:  certbot --nginx ${domains[*]} -m $EMAIL --agree-tos --redirect"
fi

echo
echo "Done. Visit https://$DOMAIN"
echo "Logs:          journalctl -u homebuyer-lens -f"
echo "Refresh data:  systemctl start homebuyer-lens-ingest"
