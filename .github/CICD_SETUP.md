# Nullify — CI/CD Setup Guide

## Pipeline Overview

```
Push/PR → lint → test → security scan → docker build
                                              ↓
                                    (main branch only)
                                              ↓
                                       push to DockerHub
                                              ↓
                                        SSH into EC2
                                              ↓
                                       docker compose pull
                                              ↓
                                       migrate → deploy
                                              ↓
                                        health check
```

## Step 1 — Generate SSH key pair

```bash
ssh-keygen -t ed25519 -C "nullify-github-deploy" -f nullify_deploy -N ""
# Creates: nullify_deploy (private) + nullify_deploy.pub (public)
```

## Step 2 — Add public key to EC2

```bash
cat nullify_deploy.pub | ssh ubuntu@<EC2_IP> \
  "mkdir -p /home/deploy/.ssh && cat >> /home/deploy/.ssh/authorized_keys"
```

## Step 3 — Bootstrap EC2

```bash
scp ec2-bootstrap-cicd.sh ubuntu@<EC2_IP>:~/
ssh ubuntu@<EC2_IP> "sudo bash ~/ec2-bootstrap-cicd.sh"
```

## Step 4 — Copy compose files to EC2

```bash
scp docker-compose.yml deploy@<EC2_IP>:/opt/nullify/
scp .env               deploy@<EC2_IP>:/opt/nullify/
```

## Step 5 — Add GitHub Secrets

Go to: GitHub repo → Settings → Secrets → Actions → New secret

| Secret Name          | Value                                    |
|----------------------|------------------------------------------|
| `DOCKERHUB_USERNAME` | your DockerHub username                  |
| `DOCKERHUB_TOKEN`    | DockerHub access token (not password)    |
| `EC2_HOST`           | EC2 public IP or domain                  |
| `EC2_USER`           | `deploy` (created by bootstrap script)   |
| `EC2_SSH_KEY`        | contents of `nullify_deploy` (private)   |

## Step 6 — Create GitHub Environment

Go to: GitHub repo → Settings → Environments → New environment

Name: `production`

Optional: add protection rule requiring manual approval before deploy.

## Step 7 — Push to main

```bash
git add .github/
git commit -m "ci: add GitHub Actions CI/CD pipeline"
git push origin main
```

Pipeline starts automatically.

## Pipeline Behaviour

| Event              | What happens                              |
|--------------------|-------------------------------------------|
| PR opened/updated  | lint + test + security + docker build     |
| Push to `develop`  | lint + test + security + docker build     |
| Push to `main`     | everything above + push images + deploy   |

## Rollback

If a deploy breaks production:

1. GitHub → Actions → "Rollback" workflow → Run workflow
2. Enter the image tag to roll back to (e.g. `a1b2c3d`)
3. Type `ROLLBACK` to confirm
4. Pipeline SSHes into EC2 and pulls the old image

Get available tags from: `https://hub.docker.com/r/<username>/nullify-backend/tags`

## DockerHub Token

Generate at: https://hub.docker.com → Account Settings → Security → New Access Token

Permissions needed: `Read, Write, Delete`
