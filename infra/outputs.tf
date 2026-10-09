output "public_ip" {
  description = "Point the domain's A record here"
  value       = aws_eip.nullify.public_ip
}

output "ssh" {
  value = "ssh ubuntu@${aws_eip.nullify.public_ip}"
}

# The next two go into the GitHub repo's variables (.github/CICD_SETUP.md).
output "instance_id" {
  value = aws_instance.nullify.id
}

output "github_deploy_role_arn" {
  value = aws_iam_role.github_deploy.arn
}
