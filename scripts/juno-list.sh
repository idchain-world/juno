#!/usr/bin/env bash
# Inventory all Juno instances on this VPS.
#
# Reads /etc/juno/*.env for the source of truth on name/domain/ports.
# Crosses it with systemctl for the live running state.

set -euo pipefail

ENV_DIR="${JUNO_ENV_DIR:-/etc/juno}"

if ! compgen -G "${ENV_DIR}/*.env" > /dev/null; then
  echo "No Juno instances configured in ${ENV_DIR}."
  exit 0
fi

# Header
printf '%-16s  %-32s  %-6s  %-6s  %-10s  %s\n' \
  NAME DOMAIN PUBLIC OPER STATUS PID

read_env() {
  local file="$1" key="$2"
  awk -F= -v k="$key" '$1==k { sub(/^[^=]*=/,""); print; exit }' "$file"
}

for f in "${ENV_DIR}"/*.env; do
  name=$(basename "$f" .env)
  public_url=$(read_env "$f" PUBLIC_URL)
  domain=${public_url#https://}
  domain=${domain#http://}
  public_port=$(read_env "$f" PUBLIC_AGENT_PORT)
  operator_port=$(read_env "$f" OPERATOR_PORT)

  unit="juno@${name}.service"
  active=$(systemctl is-active "$unit" 2>/dev/null || echo unknown)
  pid=$(systemctl show -p MainPID --value "$unit" 2>/dev/null || echo 0)
  [ "$pid" = "0" ] && pid="-"

  printf '%-16s  %-32s  %-6s  %-6s  %-10s  %s\n' \
    "$name" "$domain" "$public_port" "$operator_port" "$active" "$pid"
done
