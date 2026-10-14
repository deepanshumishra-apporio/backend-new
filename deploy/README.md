# Deploys

`.github/workflows/pipeline.yml` tests every PR and every push to `main`, builds
a Docker image tagged with the commit SHA, pushes it to GHCR, and deploys it to
a Docker host over SSH with [`deploy.sh`](deploy.sh). There are two GitHub
environments, one server each:

| environment | server | deploys |
|---|---|---|
| `development` | sandbox VPS (FP sandbox) | automatically, on every push to `main` |
| `production` | real server (FP production) | only by hand, after a reviewer approves |

| event | what runs |
|---|---|
| pull request | typecheck, unit + schema tests, migrations on a fresh Postgres, image build (no push) |
| push to `main` | all of the above, image push, **deploy to development** |
| *Run workflow*, environment + `image_tag` | deploys that existing image only: promote it, or roll back |
| *Run workflow*, environment, no `image_tag` | full pipeline for `main`, then deploy |

**Promoting to production** = *Actions → Backend CI/CD → Run workflow*, pick
`production`, and paste the commit SHA that is already running on development.
The exact image that was tested there ships; nothing rebuilds.

Run one instance. Every replica runs the reconcile, compliance and announcement
loops; they are written to be idempotent, but one server is the tested setup.

## One-time setup

### 1. Server (any Linux VM: EC2, DigitalOcean, Hetzner, …)

Mumbai region (`ap-south-1` / `blr1`) keeps investor traffic in India.

```bash
# Docker
curl -fsSL https://get.docker.com | sh

# A deploy user that can run Docker and nothing else
sudo useradd -m -s /bin/bash deploy
sudo usermod -aG docker deploy
sudo install -d -o deploy -g deploy -m 700 /opt/backend
```

Put the deploy job's **public** key in `/home/deploy/.ssh/authorized_keys`
(generate the pair with `ssh-keygen -t ed25519 -N "" -f deploy_key`).

### 2. Production env file: `/opt/backend/.env`

Start from `.env.example` and fill in production values, then
`chmod 600 /opt/backend/.env` and `chown deploy:deploy` it.

**Docker's `--env-file` does not strip quotes.** Write `KEY=value`, never
`KEY="value"` — a quoted `DATABASE_URL` reaches the app with the quotes in it.

Production must have at least:

- `NODE_ENV=production`
- `DATABASE_URL` (Neon **pooled**) and `DIRECT_DATABASE_URL` (non-pooled — migrations use it)
- `FP_BASE_URL` = the production FP host, plus every `FP_*` credential
- `MSG91_*`, `BANK_FINGERPRINT_KEY`, `STAFF_MFA_ENCRYPTION_KEY`, `FP_WEBHOOK_ADMIN_SECRET`
- `TRUST_PROXY` set (the app sits behind the reverse proxy below), `PUBLIC_API_BASE_URL`, `CALLBACK_ALLOWED_ORIGINS`
- `OTP_DEV_CODE` empty, `OTP_EMAIL_FALLBACK=false`, `SANDBOX_AUTH_ENABLED=false`, `FP_REQUIRE_PAYOUT_ACCOUNT_VERIFICATION=true`

The app refuses to boot on the dangerous combinations, and `deploy.sh` then
restores the previous container — but check anyway.

### 3. HTTPS

The container listens on `127.0.0.1:3000` only, unless
`/opt/backend/deploy.conf` says `BIND_ADDRESS=0.0.0.0` (plain HTTP straight to
the internet — a stopgap until a domain exists). Put Caddy or nginx in front for
TLS. Caddy is two lines in `/etc/caddy/Caddyfile`:

```
api.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

### 4. GitHub

**Settings → Environments**, create both:

- `development`: *Deployment branches* `main` only, no reviewers.
- `production`: *Deployment branches* `main` only, *Required reviewers* =
  whoever may approve a production deploy.

Each gets the same four secrets, pointing at its own server (and its own
deploy key — never share one key between the two):

| secret | value |
|---|---|
| `DEPLOY_HOST` | server IP or hostname |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_SSH_KEY` | the **private** key (`deploy_key` file contents) |
| `DEPLOY_KNOWN_HOSTS` | output of `ssh-keyscan -t ed25519 <host>` — verify the fingerprint against the server console |

App secrets do **not** go into GitHub; they live only in `/opt/backend/.env`.

**Settings → Branches → `main`:** require the *Typecheck and tests*,
*Migrations apply and match the schema* and *Docker image* checks to pass
before merging.

## Rolling back

*Actions → Backend CI/CD → Run workflow*, pick the environment and paste the
full commit SHA of the last good deploy into `image_tag`. The image is reused
as-is; nothing rebuilds.

The database is **not** rolled back. That is why migrations have to stay
backward compatible: add a column in one release, stop using the old one in the
next, drop it in a third.

## Day-to-day on the server

```bash
docker logs -f --tail 200 backend                       # logs
docker exec -it backend bun run staff:create            # admin account (see the script header)
docker inspect --format '{{.Config.Image}}' backend     # what is running
```
