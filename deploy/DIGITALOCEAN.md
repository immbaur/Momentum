# Deploying Momentum on the existing heyimmi.com Droplet

Momentum runs alongside the `heyimmi.com` landing page on the same
DigitalOcean droplet — they share the box, Caddy, and the domain, but stay
fully isolated: Momentum is a separate app under its own user and systemd
service, reached through a new `momentum.heyimmi.com` subdomain. The landing
page is never touched.

Why a droplet (and not App Platform): Momentum keeps all your training data
as flat files under `data/`, which App Platform's ephemeral filesystem would
wipe on every deploy, and it **spawns the Claude Code CLI** server-side to
generate workouts — something a static-hosting platform can't do.

The stack after this:

```
                          ┌─> /var/www/heyimmi.com        (static, unchanged)
phone/browser ─HTTPS─> Caddy
  (via Cloudflare)        └─> 127.0.0.1:3000  node server.js  (systemd: momentum)
                                                    └─> claude CLI (workout gen)
```

The droplet was resized to **2 GB RAM / 50 GB disk** for this — enough for
the Node server plus the Claude CLI it spawns during workout generation.

## 0. Prerequisites

- SSH access to the droplet as `root` (you already deploy the landing page
  this way — IP and key are in `heyimmi.com/PRIVATE_INFRA.md`).
- Claude auth for the server — one of:
  - **Claude subscription (Pro/Max)**: on your *local* machine run
    `claude setup-token`, complete the browser flow, and copy the long-lived
    token. You'll set it as `CLAUDE_CODE_OAUTH_TOKEN` on the droplet.
  - **API key**: create one at <https://console.anthropic.com> and set it as
    `ANTHROPIC_API_KEY`. Bills per token instead of using a subscription.

All commands below are run as `root` on the droplet unless noted.

## 1. DNS: add the subdomain

In Cloudflare (the domain's DNS host), add a record so
`momentum.heyimmi.com` resolves to the droplet:

```text
Type: A
Name: momentum
IPv4 address: 178.128.150.117
Proxy status: Proxied   (orange cloud — matches the root domain)
TTL: Auto
```

Proxied is fine: Cloudflare exempts the `/.well-known/acme-challenge/` path
from its HTTPS redirect, so Caddy's HTTP-01 certificate challenge still
works, exactly as it did for the root domain.

## 2. Add swap (safety margin)

2 GB is comfortable, but a swapfile keeps an agent run from ever OOM-killing
Caddy or the landing page under a memory spike. The 50 GB disk has room:

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
free -h    # should now show 2.0Gi swap
```

## 3. Install Node and create the app user

The landing page is static, so Node isn't on the box yet.

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

adduser --disabled-password --gecos "" momentum
```

## 4. Install the app and the Claude CLI

As the `momentum` user:

```bash
su - momentum
git clone https://github.com/immbaur/Momentum.git
cd Momentum
npm install --omit=dev

# Claude Code CLI — native installer, lands in ~/.local/bin
curl -fsSL https://claude.ai/install.sh | bash
exit
```

If the GitHub repo is private, make it public or add a read-only deploy key
on the droplet first.

## 5. Configure secrets

Back as `root`, create `/etc/momentum.env`:

```bash
cat > /etc/momentum.env <<'EOF'
MOMENTUM_PASSWORD=pick-a-strong-password
CLAUDE_CODE_OAUTH_TOKEN=paste-token-from-claude-setup-token
EOF
chmod 600 /etc/momentum.env
```

(Use `ANTHROPIC_API_KEY=...` instead of the OAuth token line if you went the
API-key route.)

## 6. Start the service

The systemd unit binds the app to `127.0.0.1:3000`, so it's reachable only
through Caddy — never directly from the internet.

```bash
cp /home/momentum/Momentum/deploy/momentum.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now momentum
systemctl status momentum        # should be active (running)
```

## 7. Add the Caddy site block

Caddy already serves the landing page from `/etc/caddy/Caddyfile`. **Append**
Momentum's block — don't replace the file, or you'll drop heyimmi.com:

```bash
cat /home/momentum/Momentum/deploy/momentum.caddy >> /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

Once DNS has propagated, open `https://momentum.heyimmi.com` — Caddy fetches
the certificate on the first request. Log in with the password from
`/etc/momentum.env`, then verify end-to-end by **generating a workout**
(this is what exercises the Claude CLI under systemd). Confirm the landing
page still loads at `https://heyimmi.com`.

## 8. Automated deploys (GitHub Actions)

After the one-time bootstrap above, every push to `main` redeploys
automatically via `.github/workflows/deploy.yml`. Each run SSHes to the
droplet, writes `/etc/momentum.env` from your GitHub secrets, then updates
the code (`git reset --hard origin/main` + `npm ci --omit=dev`), refreshes
the systemd unit, restarts the service, and health-checks it on `:3000`.
Your `data/` directory is gitignored, so deploys never touch your workout
history, auth, or sessions.

### Secrets vs. Variables

Yes — set the password in GitHub. Put it under **Secrets**, not Variables:
repo → **Settings → Secrets and variables → Actions → Secrets → New
repository secret**. Secrets are encrypted and masked in logs; *Variables*
are plaintext and visible, so they're only for non-sensitive config (we
don't need any here — everything below is a secret).

| Secret | Value | Notes |
|---|---|---|
| `DROPLET_HOST` | `178.128.150.117` | Same droplet as the landing page |
| `DROPLET_USER` | `root` | Deploy needs root to write `/etc` + restart the service |
| `DROPLET_SSH_KEY` | private deploy key | You can reuse the landing-page key (`~/.ssh/heyimmi_github_actions_ed25519`) — its public half is already in the droplet's `root` authorized_keys |
| `MOMENTUM_PASSWORD` | your login password | Written to `/etc/momentum.env` on each deploy |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude setup-token` output | **Set this _or_** `ANTHROPIC_API_KEY` |
| `ANTHROPIC_API_KEY` | API key | Alternative to the OAuth token |

Because the workflow rewrites `/etc/momentum.env` on every deploy, **GitHub
is the single source of truth** for these values — don't hand-edit the file
on the droplet, it'll be overwritten. To rotate the password, change the
`MOMENTUM_PASSWORD` secret and re-run the workflow (Actions → Deploy Momentum
→ Run workflow); the restart logs out all existing sessions.

If you'd rather keep secrets only on the droplet, delete the "Sync secrets"
step from the workflow and manage `/etc/momentum.env` by hand (step 5).

## 9. Day-to-day

**Logs**

```bash
journalctl -u momentum -f
```

**Deploying app updates** — just push to `main`; GitHub Actions (section 8)
does it. To deploy by hand instead (e.g. Actions is down):

```bash
su - momentum -c 'cd Momentum && git pull && npm install --omit=dev'
systemctl restart momentum
```

**Backing up your data** — everything that matters is `data/` (history CSV,
auth, sessions). If you don't have DO Backups on, pull a copy occasionally:

```bash
rsync -a momentum@178.128.150.117:Momentum/data/ ~/momentum-data-backup/
```

**Changing the password** — update the `MOMENTUM_PASSWORD` GitHub secret and
re-run the Deploy workflow (this rewrites `/etc/momentum.env` and restarts,
logging out all sessions). Only hand-edit `/etc/momentum.env` if you removed
the secrets step from the workflow.
