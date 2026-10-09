# Security Policy

## Supported versions

Only the latest release (the newest `v*` tag) gets security fixes. Fixes ship as a new tag; there are no
backports.

## Reporting a vulnerability

Please do not open a public issue, pull request or discussion for a security problem.

Report it privately through GitHub: the repository's **Security** tab, then **Report a vulnerability**. Include:

- what is affected (endpoint, file, workflow or infrastructure resource) and the version or commit;
- steps to reproduce, or a proof of concept;
- the impact you expect (data exposed, privilege gained, service disrupted).

This is a one-maintainer project, so these are targets, not guarantees:

| Step | Target |
|---|---|
| Acknowledge the report | 7 days |
| Confirm or rule out the issue | 14 days |
| Release a fix for a confirmed issue | 30 days, sooner for anything critical |

You will be kept up to date on progress and credited in the advisory unless you would rather not be.

## Scope

In scope:

- the backend API, WebSocket and authentication (`backend/`);
- the frontend and its nginx configuration (`frontend/`);
- the deployment path: GitHub Actions workflows, `infra/` Terraform and `deploy.sh`, `docker-compose.yml`.

Out of scope:

- denial of service by volume, and findings that need a compromised host or GitHub account;
- missing best-practice headers or settings with no demonstrated impact;
- vulnerabilities in third-party dependencies that are already public (Dependabot tracks those), unless this
  project uses them in an exploitable way;
- social engineering.

Please test only against your own deployment (see the README), never against someone else's instance.

## How the project defends itself

Every CI run scans for leaked secrets (gitleaks), vulnerable dependencies (pip-audit, npm audit), insecure Python
(bandit), unsafe workflows (zizmor) and vulnerable images (Trivy). See the Security section of the
[README](README.md#security) for the runtime controls.
