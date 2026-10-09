variable "region" {
  description = "AWS region"
  type        = string
  default     = "ap-south-1"
}

variable "instance_type" {
  description = "c7i-flex.large (2 vCPU, 4 GiB) is free-tier eligible; m7i-flex.large doubles the memory, also free tier"
  type        = string
  default     = "c7i-flex.large"
}

variable "ssh_cidr" {
  description = "The only network allowed to SSH in, e.g. your IP as 203.0.113.7/32"
  type        = string

  validation {
    condition     = can(cidrhost(var.ssh_cidr, 0)) && var.ssh_cidr != "0.0.0.0/0"
    error_message = "ssh_cidr must be a CIDR and not 0.0.0.0/0."
  }
}

variable "ssh_public_key_path" {
  description = "Public key installed for the ubuntu user"
  type        = string
  default     = "~/.ssh/id_ed25519.pub"
}
