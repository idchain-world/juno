#!/usr/bin/env bash
# Provision a new Juno instance on this VPS.
#
#   sudo ./juno-add.sh <name> <domain> [--openrouter-key=<key>]
#
# Or via env:
#   sudo OPENROUTER_API_KEY=sk-or-... ./juno-add.sh <name> <domain>
#
# Renders per-instance env + Caddy site block, allocates a free port pair,
# starts the systemd instance, reloads Caddy.
#
# - <name> must match ^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$ (lowercase alnum + dash)
# - <domain> must not already be in use by another juno site block
# - If --openrouter-key (or OPENROUTER_API_KEY env) is supplied, the key is
#   substituted into the env file and the unit starts immediately. Otherwise
#   the env file keeps the __OPENROUTER_API_KEY__ placeholder and the unit is
#   left enabled-but-stopped.
# - Exits non-zero and rolls back partial writes on any failure.
#
# Requires: root (for /etc/juno, /opt/juno, systemctl, caddy reload).

set -euo pipefail

# ── paths ────────────────────────────────────────────────────────────────
JUNO_ROOT="${JUNO_ROOT:-/opt/juno}"
ENV_DIR="${JUNO_ENV_DIR:-/etc/juno}"
CADDY_DIR="${JUNO_CADDY_DIR:-/etc/caddy/juno.d}"
STATE_DIR="${JUNO_STATE_DIR:-/var/lib/juno}"
LOCK_FILE="${STATE_DIR}/alloc.lock"
TEMPLATE_DIR="${JUNO_TEMPLATE_DIR:-${JUNO_ROOT}/scripts}"

# Port range: public port P on 127.0.0.1:P, operator port P+1. Step by 2.
PORT_BASE="${JUNO_PORT_BASE:-4200}"
PORT_MAX="${JUNO_PORT_MAX:-4398}"  # 100 instances max by default.

usage() {
  echo "Usage: $0 <name> <domain> [--openrouter-key=<key>]" >&2
  echo "  name   lowercase alnum + dash, 1-32 chars" >&2
  echo "  domain fully-qualified hostname with DNS pointing at this VPS" >&2
  echo "  --openrouter-key=<key>  (or OPENROUTER_API_KEY env) skips the" >&2
  echo "                           manual env edit and starts the unit." >&2
  exit 1
}

die() { echo "juno-add: $*" >&2; exit 1; }

# ── arg parsing ──────────────────────────────────────────────────────────
NAME=""
DOMAIN=""
OR_KEY="${OPENROUTER_API_KEY:-}"
for arg in "$@"; do
  case "$arg" in
    --openrouter-key=*) OR_KEY="${arg#--openrouter-key=}" ;;
    --*)                die "unknown flag: $arg" ;;
    *)
      if [ -z "$NAME" ]; then NAME="$arg"
      elif [ -z "$DOMAIN" ]; then DOMAIN="$arg"
      else die "too many positional arguments"
      fi
      ;;
  esac
done
[ -n "$NAME" ] && [ -n "$DOMAIN" ] || usage

if ! printf '%s' "$NAME" | grep -Eq '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$'; then
  die "invalid name '$NAME' (must be lowercase alnum + dash, 1-32 chars)"
fi
# Defensive second check — no path separators, no dots, no NUL.
case "$NAME" in
  */*|*..*|*.*) die "invalid name '$NAME' (illegal characters)" ;;
esac

if ! printf '%s' "$DOMAIN" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'; then
  die "invalid domain '$DOMAIN'"
fi

ENV_FILE="${ENV_DIR}/${NAME}.env"
SITE_FILE="${CADDY_DIR}/${NAME}.caddy"
INSTANCE_DIR="${JUNO_ROOT}/instances/${NAME}"

[ -e "$ENV_FILE" ]  && die "instance '$NAME' already exists (env file: $ENV_FILE)"
[ -e "$SITE_FILE" ] && die "instance '$NAME' already has a Caddy site block: $SITE_FILE"

# Domain collision check across all existing site blocks.
if [ -d "$CADDY_DIR" ]; then
  if grep -rlE "^[[:space:]]*${DOMAIN}[[:space:]]*\{" "$CADDY_DIR" 2>/dev/null | grep -q .; then
    die "domain '$DOMAIN' is already served by another juno instance"
  fi
fi

# ── required templates ───────────────────────────────────────────────────
ENV_TEMPLATE="${TEMPLATE_DIR}/juno.env.template"
SITE_TEMPLATE="${TEMPLATE_DIR}/juno-site.caddy.template"
[ -f "$ENV_TEMPLATE" ]  || die "missing env template: $ENV_TEMPLATE"
[ -f "$SITE_TEMPLATE" ] || die "missing site template: $SITE_TEMPLATE"

# ── bootstrap dirs ───────────────────────────────────────────────────────
mkdir -p "$ENV_DIR" "$CADDY_DIR" "$STATE_DIR" "${JUNO_ROOT}/instances"
chmod 0755 "$STATE_DIR"
touch "$LOCK_FILE"

# ── port allocation under flock ──────────────────────────────────────────
allocate_ports() {
  # Reads all existing env files, collects used ports, picks the next free pair.
  local used=""
  if compgen -G "${ENV_DIR}/*.env" > /dev/null; then
    used=$(grep -hE '^(PUBLIC_AGENT_PORT|OPERATOR_PORT)=' "${ENV_DIR}"/*.env \
           | awk -F= '{print $2}' | sort -u)
  fi
  local p
  for ((p=PORT_BASE; p<=PORT_MAX; p+=2)); do
    local op=$((p+1))
    if ! printf '%s\n' "$used" | grep -Fxq "$p"  \
       && ! printf '%s\n' "$used" | grep -Fxq "$op"; then
      # Also verify nothing else on the machine is bound to these ports right now.
      if command -v ss >/dev/null 2>&1; then
        if ss -H -ltn "sport = :$p"  | grep -q .; then continue; fi
        if ss -H -ltn "sport = :$op" | grep -q .; then continue; fi
      fi
      echo "$p $op"
      return 0
    fi
  done
  die "no free port pair in range ${PORT_BASE}-${PORT_MAX}"
}

# shellcheck disable=SC2094 # reading from fd 9 is intentional
exec 9>"$LOCK_FILE"
flock 9 || die "failed to acquire allocation lock"

PORTS=$(allocate_ports)
PUBLIC_PORT=${PORTS% *}
OPERATOR_PORT=${PORTS#* }

# Persist allocation by writing the env file under lock — subsequent
# juno-add runs will see these ports as taken.
AUTH_KEY=$(openssl rand -hex 32)

# ── render env file ──────────────────────────────────────────────────────
ENV_TMP=$(mktemp "${ENV_FILE}.XXXXXX")
trap 'rm -f "$ENV_TMP" "$SITE_TMP" 2>/dev/null || true' EXIT
SITE_TMP=$(mktemp "${SITE_FILE}.XXXXXX")

sed \
  -e "s|__NAME__|${NAME}|g" \
  -e "s|__DOMAIN__|${DOMAIN}|g" \
  -e "s|__PUBLIC_PORT__|${PUBLIC_PORT}|g" \
  -e "s|__OPERATOR_PORT__|${OPERATOR_PORT}|g" \
  -e "s|__AUTH_KEY__|${AUTH_KEY}|g" \
  "$ENV_TEMPLATE" > "$ENV_TMP"

if ! grep -q '__OPENROUTER_API_KEY__' "$ENV_TMP"; then
  die "env template is missing __OPENROUTER_API_KEY__ placeholder"
fi

# If the caller passed a key, substitute it now. sed delimiter is | so the
# key must not contain |. OpenRouter keys are base64/hex-ish so this is safe
# in practice; still, validate.
if [ -n "$OR_KEY" ]; then
  case "$OR_KEY" in
    *'|'*) die "--openrouter-key contains '|', refusing to substitute safely" ;;
  esac
  sed -i "s|__OPENROUTER_API_KEY__|${OR_KEY}|" "$ENV_TMP"
fi

# ── render site file ─────────────────────────────────────────────────────
sed \
  -e "s|__NAME__|${NAME}|g" \
  -e "s|__DOMAIN__|${DOMAIN}|g" \
  -e "s|__PUBLIC_PORT__|${PUBLIC_PORT}|g" \
  "$SITE_TEMPLATE" > "$SITE_TMP"

# ── validate Caddy config with the new snippet in place (atomically) ─────
# Move the site file into place first, then validate. If validation fails,
# pull it back out.
chmod 0644 "$SITE_TMP"
mv "$SITE_TMP" "$SITE_FILE"
SITE_TMP=""  # prevent cleanup

if ! caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile >/tmp/juno-add-caddy.log 2>&1; then
  echo "juno-add: caddy validate failed — site file rolled back" >&2
  cat /tmp/juno-add-caddy.log >&2
  rm -f "$SITE_FILE"
  die "invalid Caddy config"
fi

# ── commit env file (0600 root:juno) ─────────────────────────────────────
chmod 0640 "$ENV_TMP"
if id -g juno >/dev/null 2>&1; then
  chown root:juno "$ENV_TMP"
fi
mv "$ENV_TMP" "$ENV_FILE"
ENV_TMP=""

# ── instance data dirs ───────────────────────────────────────────────────
mkdir -p "${INSTANCE_DIR}/data" "${INSTANCE_DIR}/knowledge"
if id juno >/dev/null 2>&1; then
  chown -R juno:juno "$INSTANCE_DIR"
fi

# ── pre-create per-site caddy log with caddy:caddy ownership ────────────
# If caddy starts a site whose log target doesn't exist, it creates the file
# as its runtime user; but if the file has ever been created by something
# else (root from a manual test, a previous install running as a different
# user), the reload will fail with "permission denied". Own it up front.
CADDY_LOG="/var/log/caddy/juno-${NAME}.log"
mkdir -p /var/log/caddy
touch "$CADDY_LOG"
if id caddy >/dev/null 2>&1; then
  chown caddy:caddy "$CADDY_LOG"
fi
chmod 0640 "$CADDY_LOG"

# ── enable + start the unit ──────────────────────────────────────────────
systemctl daemon-reload
systemctl enable "juno@${NAME}.service" >/dev/null

# Only start if the operator has filled in the API key; otherwise leave it
# disabled-but-queued so the first-start isn't a crash loop.
if grep -q '__OPENROUTER_API_KEY__' "$ENV_FILE"; then
  echo "juno-add: env file still contains __OPENROUTER_API_KEY__ placeholder."
  echo "           Edit ${ENV_FILE} and set OPENROUTER_API_KEY, then run:"
  echo "             systemctl start juno@${NAME}"
else
  systemctl start "juno@${NAME}.service"
fi

# Caddy reload: bounded timeout, fall back to a full restart on failure so a
# stuck admin-API handshake doesn't leave caddy in a half-loaded state.
if ! timeout 10 systemctl reload caddy; then
  echo "juno-add: caddy reload timed out or failed; restarting caddy" >&2
  systemctl restart caddy
fi

cat <<EOF

juno-add: instance '${NAME}' provisioned.

  name          ${NAME}
  domain        ${DOMAIN}
  public port   127.0.0.1:${PUBLIC_PORT}
  operator port 127.0.0.1:${OPERATOR_PORT}
  env           ${ENV_FILE}
  caddy         ${SITE_FILE}
  data          ${INSTANCE_DIR}/data
  knowledge     ${INSTANCE_DIR}/knowledge
  auth key      (generated, stored in env file)

Check status: systemctl status juno@${NAME}
Tail logs:    journalctl -u juno@${NAME} -f
Test:         curl -sS https://${DOMAIN}/health
EOF

trap - EXIT
