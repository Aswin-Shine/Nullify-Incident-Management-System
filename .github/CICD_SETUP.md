# CI/CD setup

`workflows/ci.yml` runs on every PR and every pushed `v*` tag. Plain pushes to main run nothing, so small commits
cost no CI minutes. To release: `git tag v1.2.3 && git push origin v1.2.3` (the tagged commit must be on main).


| Job | What it does |
|---|---|
| Backend | ruff, then the full pytest suite against Postgres 16 and Redis 7 (coverage must stay at 80% or more) |
| Frontend | eslint, vitest, vite build |
| Security and config checks | gitleaks (whole history), pip-audit, npm audit, bandit, zizmor (these workflows), the deploy script's tests, terraform fmt/validate, promtool alert tests, `docker compose config` |
| Docker images | builds both images for linux/amd64, fails on a CRITICAL or HIGH CVE that has a fix (Trivy); on a tag, pushes `aswinshine/nullify-*:<commit sha>` to Docker Hub |
| Deploy | tags only: `workflows/deploy.yml` with that commit |

`workflows/deploy.yml` assumes an AWS role through OIDC (no stored AWS keys), runs `infra/deploy.sh <sha>` on the
box through SSM (port 22 stays closed to GitHub), then checks `https://<DOMAIN>/health`. The script pulls the
commit's images, runs the migrations, restarts, and goes back to the previous version if the pull, the migration
or the backend healthcheck fails.

## One-time setup

1. **AWS:** `cd infra && terraform apply` creates the deploy role and lets the box take SSM commands. Note the
   outputs `instance_id` and `github_deploy_role_arn`.
2. **The box:** copy the server env file to `/opt/nullify/.env` (`infra/README.md` step 4). That is all the first
   CI deploy needs: it downloads `docker-compose.yml` and pulls the images itself. CI never writes secrets; it
   only sets `IMAGE_TAG` in that file.
3. **Docker Hub:** Account settings, Personal access tokens, a token with Read & Write.
4. **GitHub** (repo Settings):
   - Environments, new environment `production`. Optional: add yourself as a required reviewer, so every deploy
     waits for a click.
     Deployment branches and tags: selected, branch `main` (manual rollbacks) and tag `v*` (releases).
   - Secrets and variables, Actions:

     | Kind | Name | Value |
     |---|---|---|
     | Secret | `DOCKERHUB_TOKEN` | the token from step 3 |
     | Variable | `DOCKERHUB_USERNAME` | `aswinshine` |
     | Variable | `AWS_REGION` | `ap-south-1` |
     | Variable | `AWS_DEPLOY_ROLE_ARN` | the `github_deploy_role_arn` output |
     | Variable | `EC2_INSTANCE_ID` | the `instance_id` output |
     | Variable | `DOMAIN` | your domain, e.g. `ims.example.com` |

   - Code security: turn on Dependabot alerts and security updates. `dependabot.yml` already opens weekly
     update PRs for the actions (pinned to commit SHAs), pip, npm and the Dockerfile base images.

## Rolling back

Actions tab, Deploy, Run workflow, paste the full SHA of an earlier release tag's commit (its images are on
Docker Hub). Migrations are not undone, so pick a commit whose code works with the current schema.

The deploy fetches `infra/deploy.sh`, `docker-compose.yml` and the `monitoring/` config from raw.githubusercontent.com at that SHA, which
works while the repo is public; a private repo would need a token on the box.
