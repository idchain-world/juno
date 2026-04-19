#!/usr/bin/env bash
# Remove a Juno instance from this VPS.
#
#   sudo ./juno-remove.sh <name>            # stops + removes unit/env/site; keeps data
#   sudo ./juno-remove.sh <name> --purge    # also deletes /opt/juno/instances/<name>
#
# --purge requires typing the instance name back as confirmation.
# Data dirs are kept by default so an accidental removal is recoverable.

set -euo pipefail

JUNO_ROOT="${JUNO_ROOT:-/opt/juno}"
ENV_DIR="${JUNO_ENV_DIR:-/etc/juno}"
CADDY_DIR="${JUNO_CADDY_DIR:-/etc/caddy/juno.d}"

usage() { echo "Usage: $0 <name> [--purge]" >&2; exit 1; }
die()   { echo "juno-remove: $*" >&2; exit 1; }

[ "$#" -ge 1 ] || usage
NAME="$1"
PURGE="${2:-}"

if ! printf '%s' "$NAME" | grep -Eq '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$'; then
  die "invalid name '$NAME'"
fi

ENV_FILE="${ENV_DIR}/${NAME}.env"
SITE_FILE="${CADDY_DIR}/${NAME}.caddy"
INSTANCE_DIR="${JUNO_ROOT}/instances/${NAME}"

EXISTS=0
[ -f "$ENV_FILE" ]  && EXISTS=1
[ -f "$SITE_FILE" ] && EXISTS=1
if systemctl list-unit-files "juno@${NAME}.service" 2>/dev/null | grep -q "juno@${NAME}"; then
  EXISTS=1
fi
[ "$EXISTS" -eq 1 ] || die "instance '$NAME' not found"

# ── stop + disable ───────────────────────────────────────────────────────
systemctl stop    "juno@${NAME}.service" 2>/dev/null || true
systemctl disable "juno@${NAME}.service" 2>/dev/null || true

# ── remove env + site files ──────────────────────────────────────────────
rm -f "$ENV_FILE" "$SITE_FILE"

systemctl reload caddy 2>/dev/null || systemctl restart caddy 2>/dev/null || true

# ── purge data dir (interactive confirmation) ────────────────────────────
if [ "$PURGE" = "--purge" ]; then
  if [ ! -d "$INSTANCE_DIR" ]; then
    echo "juno-remove: no data dir at $INSTANCE_DIR — nothing to purge"
  else
    echo ""
    echo "About to DELETE $INSTANCE_DIR and everything inside it."
    echo "This includes the inbox, session state, and knowledge files."
    printf "Retype the instance name to confirm: "
    read -r CONFIRM
    if [ "$CONFIRM" != "$NAME" ]; then
      die "confirmation mismatch — data dir NOT purged"
    fi
    rm -rf "$INSTANCE_DIR"
    echo "juno-remove: purged $INSTANCE_DIR"
  fi
elif [ -n "$PURGE" ]; then
  die "unknown flag '$PURGE' (only --purge is supported)"
fi

cat <<EOF

juno-remove: instance '${NAME}' removed.

  unit disabled   juno@${NAME}.service
  env file        $( [ -f "$ENV_FILE" ] && echo PRESENT || echo deleted )
  site file       $( [ -f "$SITE_FILE" ] && echo PRESENT || echo deleted )
  data dir        $( [ -d "$INSTANCE_DIR" ] && echo "kept at $INSTANCE_DIR" || echo deleted )

EOF
