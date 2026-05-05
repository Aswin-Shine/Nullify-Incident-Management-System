#!/usr/bin/env bash
# =============================================================
# Nullify — EC2 Bootstrap for CI/CD
# Run ONCE on a fresh EC2 before the first pipeline deploy
#
# Usage:
#   chmod +x ec2-bootstrap-cicd.sh
#   sudo ./ec2-bootstrap-cicd.sh
# =============================================================

set -euo pipefail

GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
info() { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()   { echo -e "${GREEN}[OK]${NC}   $*"; }

[[ $EUID -eq 0 ]] || { echo "Run as root: sudo ./ec2-bootstrap-cicd.sh"; exit 1; }

# ── 1. Install Docker ─────────────────────────────────────────
info "Installing Docker..."
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  tee /etc/apt/sources.list.d/docker.list > /dev/null

apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
systemctl enable docker
systemctl start docker
ok "Docker installed"

# ── 2. Create deploy user ────────────────────────────────────
DEPLOY_USER="deploy"
if ! id "$DEPLOY_USER" &>/dev/null; then
  useradd --create-home --shell /bin/bash --groups docker "$DEPLOY_USER"
  ok "User '$DEPLOY_USER' created"
else
  usermod -aG docker "$DEPLOY_USER"
  ok "User '$DEPLOY_USER' already exists — added to docker group"
fi

# ── 3. Set up SSH for GitHub Actions ─────────────────────────
info "Setting up SSH for deploy user..."
DEPLOY_HOME="/home/${DEPLOY_USER}"
mkdir -p "${DEPLOY_HOME}/.ssh"
chmod 700 "${DEPLOY_HOME}/.ssh"

# Paste your GitHub Actions public key below (from EC2_SSH_KEY secret counterpart)
# OR: cat ~/.ssh/authorized_keys >> ${DEPLOY_HOME}/.ssh/authorized_keys
touch "${DEPLOY_HOME}/.ssh/authorized_keys"
chmod 600 "${DEPLOY_HOME}/.ssh/authorized_keys"
chown -R "${DEPLOY_USER}:${DEPLOY_USER}" "${DEPLOY_HOME}/.ssh"
ok "SSH directory ready — add your public key to ${DEPLOY_HOME}/.ssh/authorized_keys"

# ── 4. Create app directory ──────────────────────────────────
info "Creating /opt/nullify..."
mkdir -p /opt/nullify
chown "${DEPLOY_USER}:${DEPLOY_USER}" /opt/nullify

# ── 5. Copy docker-compose.yml + .env to EC2 ────────────────
# You must manually scp these files:
#   scp docker-compose.yml deploy@<EC2_IP>:/opt/nullify/
#   scp .env               deploy@<EC2_IP>:/opt/nullify/
ok "/opt/nullify ready — remember to scp docker-compose.yml and .env"

# ── 6. UFW firewall ──────────────────────────────────────────
info "Configuring firewall..."
ufw allow OpenSSH
ufw allow 80/tcp
ufw --force enable
ok "Firewall: SSH + HTTP open"

echo ""
echo "======================================================"
echo "  EC2 bootstrap complete."
echo ""
echo "  Next steps:"
echo "  1. scp docker-compose.yml deploy@<EC2_IP>:/opt/nullify/"
echo "  2. scp .env               deploy@<EC2_IP>:/opt/nullify/"
echo "  3. Add SSH public key to /home/deploy/.ssh/authorized_keys"
echo "  4. Add GitHub Secrets (see README below)"
echo "======================================================"
