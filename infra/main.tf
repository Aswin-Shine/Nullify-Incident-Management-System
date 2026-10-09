# Nullify on one EC2 box: Docker Compose runs the whole stack, Caddy (the tls profile in docker-compose.yml) serves HTTPS.
# State is local (terraform.tfstate here, gitignored). ponytail: move it to an S3 backend once more than one
# person applies.

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "nullify" }
  }
}

# Canonical's current Ubuntu 24.04 LTS (amd64, gp3). Ignored after create, so a new image never replaces the box.
data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

data "aws_vpc" "default" {
  default = true
}

resource "aws_key_pair" "deploy" {
  key_name   = "nullify-deploy"
  public_key = file(pathexpand(var.ssh_public_key_path))
}

resource "aws_security_group" "nullify" {
  name        = "nullify"
  description = "Nullify: HTTPS for everyone, SSH for the admin only"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.ssh_cidr]
  }
  ingress {
    description = "HTTP (ACME challenge, redirect to HTTPS)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "HTTP/3"
    from_port   = 443
    to_port     = 443
    protocol    = "udp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    description = "Image pulls, Lets Encrypt, Slack and PagerDuty webhooks"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "nullify" {
  ami                    = data.aws_ssm_parameter.ubuntu.value
  instance_type          = var.instance_type
  key_name               = aws_key_pair.deploy.key_name
  vpc_security_group_ids = [aws_security_group.nullify.id]
  iam_instance_profile   = aws_iam_instance_profile.instance.name # SSM agent, for CI deploys (github.tf)

  metadata_options {
    http_tokens = "required" # IMDSv2 only
  }

  # Postgres, Redis and the signal lake live on this volume and go with the instance.
  # ponytail: no backups; add a DLM snapshot policy once the data matters.
  root_block_device {
    volume_type = "gp3"
    volume_size = 30 # the free-tier EBS allowance
    encrypted   = true
  }

  # Docker Engine + Compose plugin from Docker's apt repository (docs.docker.com/engine/install/ubuntu).
  user_data = <<-EOF
    #!/bin/bash
    set -euxo pipefail
    apt-get update
    apt-get install -y ca-certificates curl
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    cat > /etc/apt/sources.list.d/docker.sources <<SRC
    Types: deb
    URIs: https://download.docker.com/linux/ubuntu
    Suites: $(. /etc/os-release && echo "$${UBUNTU_CODENAME:-$VERSION_CODENAME}")
    Components: stable
    Architectures: $(dpkg --print-architecture)
    Signed-By: /etc/apt/keyrings/docker.asc
    SRC
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    usermod -aG docker ubuntu
    install -d -o ubuntu -g ubuntu -m 0750 /opt/nullify
  EOF

  lifecycle {
    ignore_changes = [ami, user_data]
  }

  tags = { Name = "nullify" }
}

# A fixed address for the DNS A record; survives stop/start.
resource "aws_eip" "nullify" {
  instance = aws_instance.nullify.id
  domain   = "vpc"
  tags     = { Name = "nullify" }
}
