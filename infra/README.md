# Deploy to EC2

One Ubuntu 24.04 box (c7i-flex.large, free tier) runs the Compose stack. Caddy (the `tls` profile in
`docker-compose.yml`, Caddyfile inline) gets a Let's Encrypt certificate, redirects HTTP to HTTPS and sends HSTS.

1. **Box.** `cd infra && cp terraform.tfvars.example terraform.tfvars`, set `ssh_cidr` to your IP/32, then
   `terraform init && terraform apply`. Docker installs on first boot (about 2 minutes).
2. **DNS.** Point the domain's A record at the `public_ip` output. Caddy retries until it resolves.
3. **Images** (the box is x86_64; a Mac builds arm64 by default), from the repo root:
   `DOCKER_DEFAULT_PLATFORM=linux/amd64 docker compose build backend frontend && docker compose push backend frontend`
4. **Config.** `cp .env.server.example .env.server` (gitignored), set the three secrets (`openssl rand -hex 32`
   each), `DOMAIN`, `ACME_EMAIL` and the domain in `ALLOWED_ORIGINS`. Then copy the two files:
   ```bash
   scp docker-compose.yml ubuntu@<ip>:/opt/nullify/
   scp .env.server ubuntu@<ip>:/opt/nullify/.env
   ```
5. **Start** (on the box, in `/opt/nullify`):
   ```bash
   docker compose pull
   docker compose run --rm migrate
   docker compose up -d --no-build
   docker compose exec backend python -m app.cli create-user --username admin --email you@example.com --role admin
   ```

Updating: after this first deploy, every pushed `v*` tag deploys itself once CI passes (plain pushes to main run nothing) (`.github/CICD_SETUP.md`
has the one-time GitHub and AWS setup). By hand, for any commit CI has built: `sudo bash infra/deploy.sh <full sha>`
on the box (the script is in the repo; copy it over or fetch it).

Not set up yet: remote Terraform state, backups (Postgres lives on the root volume and is deleted with the
instance). Grafana and Prometheus (`--profile monitoring`) get their `monitoring/` config from each `deploy.sh` run; reach them with
`ssh -L 3001:127.0.0.1:3001 ubuntu@<ip>`.
