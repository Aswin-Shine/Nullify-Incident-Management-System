# GitHub Actions deploys through SSM (.github/workflows/deploy.yml): no SSH from GitHub, no stored AWS keys.
# The workflow gets short-lived credentials by OIDC and may only run commands on this one instance.

locals {
  # Only jobs in the repo's `production` environment. GitHub sends one of two forms of the claim; the second
  # carries the owner and repo ids, so a renamed or recreated repo cannot match it.
  github_subjects = [
    "repo:Aswin-Shine/Nullify-Incident-Management-System:environment:production",
    "repo:Aswin-Shine@180327593/Nullify-Incident-Management-System@1228316933:environment:production",
  ]
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

resource "aws_iam_role" "github_deploy" {
  name = "nullify-github-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = local.github_subjects
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "github_deploy" {
  name = "run-deploy-on-nullify"
  role = aws_iam_role.github_deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "ssm:SendCommand"
        Resource = [aws_instance.nullify.arn, "arn:aws:ssm:${var.region}::document/AWS-RunShellScript"]
      },
      {
        Effect   = "Allow"
        Action   = "ssm:GetCommandInvocation" # has no resource-level permissions
        Resource = "*"
      },
    ]
  })
}

# Lets the SSM agent on the box (preinstalled on Canonical's Ubuntu AMIs) register and take commands.
resource "aws_iam_role" "instance" {
  name = "nullify-instance"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "instance_ssm" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "instance" {
  name = "nullify-instance"
  role = aws_iam_role.instance.name
}
