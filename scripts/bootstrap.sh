#!/usr/bin/env bash
# Bootstrap a fresh Ubuntu 24.04 box for one-or-many Juno instances.
# Run as root on a clean VPS. Idempotent — safe to re-run.
#
# After this script, you have the shared runtime installed. Add instances with:
#   sudo /opt/juno/scripts/juno-add.sh <name> <domain>

set -euo pipefail

JUNO_REPO="${JUNO_REPO:-https://github.com/idchain-world/juno.git}"
JUNO_ROOT="${JUNO_ROOT:-/opt/juno}"

echo "== updating apt + installing base =="
apt-get update -y
apt-get upgrade -y
apt-get install -y curl ufw debian-keyring debian-archive-keyring apt-transport-https

echo "== installing Node 22 =="
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "== installing Caddy =="
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "== firewall (22, 80, 443 only) =="
# Juno public/operator ports (4200+) stay on 127.0.0.1 — never open them externally.
ufw allow 22
ufw allow 80
ufw allow 443
ufw --force enable

echo "== creating juno user + directory layout =="
id -u juno >/dev/null 2>&1 || useradd --system --home-dir "$JUNO_ROOT" --shell /usr/sbin/nologin juno
mkdir -p "$JUNO_ROOT" "$JUNO_ROOT/instances"
mkdir -p /etc/juno                # per-instance env files
mkdir -p /etc/caddy/juno.d        # per-instance Caddy site blocks
mkdir -p /var/lib/juno            # allocation lock, any future state
chown -R juno:juno "$JUNO_ROOT"
chmod 0755 /etc/juno /etc/caddy/juno.d /var/lib/juno

echo "== cloning Juno =="
if [ ! -d "$JUNO_ROOT/.git" ]; then
  sudo -u juno git clone "$JUNO_REPO" "$JUNO_ROOT"
else
  sudo -u juno git -C "$JUNO_ROOT" pull --ff-only
fi
cd "$JUNO_ROOT"
sudo -u juno npm ci --omit=dev || sudo -u juno npm install --omit=dev
sudo -u juno npm run build

echo "== installing templated systemd unit =="
install -m 0644 "$JUNO_ROOT/scripts/juno@.service" /etc/systemd/system/juno@.service
systemctl daemon-reload

echo "== installing top-level Caddyfile (preserving any existing import directives) =="
if [ ! -f /etc/caddy/Caddyfile ] || ! grep -q 'juno.d/\*.caddy' /etc/caddy/Caddyfile; then
  install -m 0644 "$JUNO_ROOT/scripts/juno.Caddyfile" /etc/caddy/Caddyfile
fi

echo "== ensuring caddy log dir exists =="
mkdir -p /var/log/caddy
chown -R caddy:caddy /var/log/caddy 2>/dev/null || true

cat <<EOF

== BOOTSTRAP COMPLETE ==

Add your first juno instance:
  sudo $JUNO_ROOT/scripts/juno-add.sh <name> <your.domain>

Then edit /etc/juno/<name>.env to set OPENROUTER_API_KEY, and:
  sudo systemctl start juno@<name>

List instances:     sudo $JUNO_ROOT/scripts/juno-list.sh
Remove an instance: sudo $JUNO_ROOT/scripts/juno-remove.sh <name>

EOF
