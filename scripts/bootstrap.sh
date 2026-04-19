#!/usr/bin/env bash
# Bootstrap a fresh Ubuntu 24.04 box for one-or-many Juno instances.
# Run as root on a clean VPS. Idempotent — safe to re-run.
#
# After this script, you have the shared runtime installed. Add instances with:
#   sudo /opt/juno/scripts/juno-add.sh <name> <domain>

set -euo pipefail

JUNO_REPO="${JUNO_REPO:-https://github.com/idchain-world/juno.git}"
JUNO_ROOT="${JUNO_ROOT:-/opt/juno}"
APT_UPGRADE="${APT_UPGRADE:-0}"   # set to 1 to run apt-get upgrade

echo "== updating apt + installing base =="
apt-get update -y
if [ "$APT_UPGRADE" = "1" ]; then
  apt-get upgrade -y
fi
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

echo "== creating juno user + state dirs =="
id -u juno >/dev/null 2>&1 || useradd --system --home-dir "$JUNO_ROOT" --shell /usr/sbin/nologin juno
mkdir -p /etc/juno                # per-instance env files
mkdir -p /etc/caddy/juno.d        # per-instance Caddy site blocks
mkdir -p /var/lib/juno            # allocation lock, any future state
chmod 0755 /etc/juno /etc/caddy/juno.d /var/lib/juno

echo "== cloning Juno =="
# git clone requires the target to either not exist or be empty. Do the clone
# before creating $JUNO_ROOT/instances so we don't prime a non-empty parent.
if [ ! -d "$JUNO_ROOT/.git" ]; then
  if [ -d "$JUNO_ROOT" ] && [ -n "$(ls -A "$JUNO_ROOT" 2>/dev/null)" ]; then
    echo "bootstrap: $JUNO_ROOT exists and is non-empty but has no .git — aborting to avoid clobber." >&2
    echo "           Move it aside (e.g. mv $JUNO_ROOT ${JUNO_ROOT}.old) and re-run." >&2
    exit 1
  fi
  mkdir -p "$JUNO_ROOT"
  chown juno:juno "$JUNO_ROOT"
  sudo -u juno git clone "$JUNO_REPO" "$JUNO_ROOT"
else
  sudo -u juno git -C "$JUNO_ROOT" pull --ff-only
fi
mkdir -p "$JUNO_ROOT/instances"
chown -R juno:juno "$JUNO_ROOT"

cd "$JUNO_ROOT"
# Full install (dev deps needed for tsc), then build, then prune to production.
sudo -u juno npm ci
sudo -u juno npm run build
sudo -u juno npm prune --omit=dev

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
