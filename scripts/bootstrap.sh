#!/usr/bin/env bash
# Bootstrap a fresh Ubuntu 24.04 box for one Juno agent.
# Run as root on a clean VPS. Idempotent — safe to re-run.
set -euo pipefail

DOMAIN="${DOMAIN:-docs.idagents.ai}"
JUNO_REPO="${JUNO_REPO:-https://github.com/idchain-world/juno.git}"

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
ufw allow 22
ufw allow 80
ufw allow 443
ufw --force enable

echo "== creating juno user + dirs =="
id -u juno >/dev/null 2>&1 || useradd --system --home-dir /opt/juno --shell /usr/sbin/nologin juno
mkdir -p /opt/juno /opt/juno/data /opt/juno/knowledge
chown -R juno:juno /opt/juno

echo "== cloning Juno =="
if [ ! -d /opt/juno/.git ]; then
  sudo -u juno git clone "$JUNO_REPO" /opt/juno
else
  sudo -u juno git -C /opt/juno pull --ff-only
fi
cd /opt/juno
sudo -u juno npm ci --omit=dev || sudo -u juno npm install --omit=dev
sudo -u juno npm run build

echo ""
echo "== NEXT STEPS =="
echo "1. Create /etc/juno.env (chmod 600) — see scripts/juno.env.template"
echo "2. Install scripts/juno.service as /etc/systemd/system/juno.service"
echo "3. Install scripts/Caddyfile as /etc/caddy/Caddyfile (edit DOMAIN first)"
echo "4. systemctl daemon-reload && systemctl enable --now juno && systemctl reload caddy"
echo "5. Test: curl https://$DOMAIN/health"
