# Juno Deployment

Juno runs as one or many instances on a single Hetzner VPS. Each instance is
its own systemd unit (`juno@<name>`), own `/etc/juno/<name>.env`, own
Caddy site block, own `/opt/juno/instances/<name>/{data,knowledge}` tree,
and its own `PUBLIC_AGENT_PORT` / `OPERATOR_PORT` pair on `127.0.0.1`.

Shared across all instances on the box: the Node runtime, the code at
`/opt/juno`, Caddy with automatic TLS, and the `juno` system user.

## Layout

```
/opt/juno/                           # code — one clone, rolls all instances forward
  dist/  node_modules/  scripts/
  instances/
    <name>/
      data/                          # inbox, sessions, budget state
      knowledge/                     # per-instance KB markdown
/etc/juno/
  <name>.env                         # one per instance, 0640 root:juno
/etc/systemd/system/
  juno@.service                      # templated unit
/etc/caddy/
  Caddyfile                          # top-level, does `import juno.d/*.caddy`
  juno.d/
    <name>.caddy                     # one site block per instance
/var/lib/juno/
  alloc.lock                         # flock for port allocation in juno-add.sh
```

Only ports 22, 80, and 443 are open externally. Every juno public/operator
port lives on `127.0.0.1` and is reached by Caddy (public surface) or by an
SSH tunnel to the operator port (inbox, news, mcp).

## Prerequisites

- Ubuntu 24.04 VPS (Hetzner CX22 or larger — each juno reserves 512 MB by
  default; see `MemoryMax` in `scripts/juno@.service`).
- DNS records pointing each instance's domain at the VPS.
- One OpenRouter API key per instance (recommended — shared keys give you
  weak attribution and one tenant can burn the common budget).
- SSH key access as `root` or a sudo-capable user.

## Bootstrap (once per VPS)

```bash
ssh root@<vps-ip>
curl -fsSL https://raw.githubusercontent.com/idchain-world/juno/main/scripts/bootstrap.sh | bash
reboot
```

`bootstrap.sh` installs Node 22, Caddy, UFW, clones the repo to `/opt/juno`,
installs the templated systemd unit, and creates `/etc/juno`, `/etc/caddy/juno.d`,
and `/var/lib/juno`. It is idempotent — re-run after `git pull` to refresh the
unit file and rebuild code.

## Add a juno instance

```bash
sudo /opt/juno/scripts/juno-add.sh <name> <domain>
# e.g. sudo /opt/juno/scripts/juno-add.sh docs docs.idagents.ai
```

What `juno-add.sh` does, under a `flock`:

1. Validates `<name>` (lowercase alnum + dash, 1–32 chars) and `<domain>`.
2. Rejects duplicate names or domains already served by another instance.
3. Allocates the next free port pair from the 4200–4398 range, verifying both
   with existing env files and with `ss` (not already bound on the box).
4. Generates a fresh `PUBLIC_AGENT_AUTH_KEY` with `openssl rand -hex 32`.
5. Renders `/etc/juno/<name>.env` from `scripts/juno.env.template` (0640
   root:juno) with the allocated ports, auth key, and paths substituted in.
   The `OPENROUTER_API_KEY` placeholder is left for the operator.
6. Renders `/etc/caddy/juno.d/<name>.caddy`, runs `caddy validate`, rolls
   back on failure.
7. Creates `/opt/juno/instances/<name>/{data,knowledge}` (owned by `juno`).
8. Enables `juno@<name>.service`. Starts it immediately **only if** the
   API key placeholder has already been replaced; otherwise the unit stays
   enabled-but-stopped so the first boot isn't a crash loop.
9. Reloads Caddy.

After `juno-add.sh` returns, edit `/etc/juno/<name>.env`, replace
`__OPENROUTER_API_KEY__` with a real key, and:

```bash
sudo systemctl start juno@<name>
curl -sS https://<domain>/health
```

## List instances

```bash
sudo /opt/juno/scripts/juno-list.sh
```

Reads `/etc/juno/*.env` for the source of truth on name/domain/ports and
cross-references `systemctl` for live status and PID.

## Remove an instance

```bash
# Default: stop + disable, remove env and site file, keep the data dir.
sudo /opt/juno/scripts/juno-remove.sh <name>

# Destroy the data dir too. Script asks you to retype the instance name.
sudo /opt/juno/scripts/juno-remove.sh <name> --purge
```

Data preservation is the default so an accidental removal is recoverable.
`--purge` requires interactive confirmation (retyping the instance name).

## Per-instance environment

See [`scripts/juno.env.template`](../scripts/juno.env.template) for the full
template rendered by `juno-add.sh`. The fields the operator must fill after
provisioning are:

| Variable | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter bearer key. Prefer one key per instance. |
| `OPENROUTER_MODEL` | Default `google/gemini-2.5-flash`. |

Budget and rate-limit defaults are conservative (`MAX_TOKENS_PER_DAY=100000`,
`TALK_RATE_LIMIT_PER_MIN=20`). Raise deliberately; leaving them unset means
any one instance can burn the whole VPS budget.

## Per-instance resource limits

`scripts/juno@.service` sets, per instance:

| Limit | Default |
|---|---|
| `MemoryMax` | 512 MB |
| `MemoryHigh` | 384 MB |
| `CPUWeight` | 100 |
| `TasksMax` | 256 |
| `LimitNOFILE` | 4096 |

Override per instance with a drop-in:

```bash
sudo systemctl edit juno@docs
# write the overrides
[Service]
MemoryMax=1G
```

Systemd writes to `/etc/systemd/system/juno@docs.service.d/override.conf`.

## Operator access

Operator endpoints (`/inbox`, `/news`, `/mcp`) bind to `127.0.0.1:<operator-port>`
and are NOT proxied by Caddy. The Caddyfile also 404s any `/inbox*` coming
through the public surface as a second line of defence.

Reach the operator port from your laptop via SSH tunnel:

```bash
# Read the operator port for the instance:
sudo /opt/juno/scripts/juno-list.sh

# Then tunnel:
ssh -L 4201:127.0.0.1:4201 root@<vps-ip>
curl -H "Authorization: Bearer $PUBLIC_AGENT_AUTH_KEY" http://localhost:4201/inbox
```

The auth key is in the instance's env file.

## Upgrades

All instances share `/opt/juno` code. Upgrading the runtime rolls every
instance forward at once:

```bash
ssh root@<vps-ip>
cd /opt/juno
sudo -u juno git pull --ff-only
sudo -u juno npm ci --omit=dev
sudo -u juno npm run build
sudo systemctl restart 'juno@*'
```

If per-instance version pinning is ever needed, switch to a
`/opt/juno/releases/<sha>/` layout with a `current` symlink. It is not
needed today.

## Key rotation

### Per-instance `PUBLIC_AGENT_AUTH_KEY`

```bash
sudo openssl rand -hex 32   # copy output
sudoedit /etc/juno/<name>.env
sudo systemctl restart juno@<name>
```

### Per-instance `OPENROUTER_API_KEY`

Rotate in the OpenRouter dashboard, paste into `/etc/juno/<name>.env`,
restart the unit, then revoke the old key.

## Logs

```bash
journalctl -u juno@<name> -f
journalctl -u juno@<name> --since today
```

Caddy writes per-site access logs to `/var/log/caddy/juno-<name>.log` with
50 MB rotation, 5 files kept.

## Incident disable

**Stop one instance immediately:**

```bash
sudo systemctl stop juno@<name>
```

**Stop every juno on the box:**

```bash
sudo systemctl stop 'juno@*'
```

Takes effect within seconds. In-flight requests are dropped.

Deregister from the id-agents manager from your local CLI:

```
/public remove <domain>
```

If the instance must stay up but abuse is ongoing, drop
`TALK_RATE_LIMIT_PER_MIN` to `1` in its env file and restart the unit.
