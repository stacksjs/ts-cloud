# Bake a ts-cloud golden image as an AWS AMI (Ubuntu 24.04 base).
#
#   bun run scripts/build-image.ts        # generates ../recipe.sh
#   packer build images/packer/aws.pkr.hcl
#
# Then reference the AMI id in cloud.config.ts:
#   compute: { image: '<ami-id>', bakedImage: true }

packer {
  required_plugins {
    amazon = {
      source  = "github.com/hashicorp/amazon"
      version = ">= 1.3.0"
    }
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

source "amazon-ebs" "ubuntu" {
  region        = var.region
  instance_type = "t3.small"
  ssh_username  = "ubuntu"
  ami_name      = "ts-cloud-php-{{timestamp}}"

  # Latest Canonical Ubuntu 24.04 (same base as Hetzner) — one recipe, two clouds.
  source_ami_filter {
    filters = {
      name                = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"
      virtualization-type = "hvm"
      root-device-type    = "ebs"
    }
    owners      = ["099720109477"] # Canonical
    most_recent = true
  }

  tags = {
    "ts-cloud/golden" = "php"
  }
}

build {
  sources = ["source.amazon-ebs.ubuntu"]

  provisioner "shell" {
    # cloud-init may still be running on first boot; wait, then provision.
    inline = ["cloud-init status --wait || true"]
  }

  provisioner "shell" {
    script          = "../recipe.sh"
    execute_command = "sudo -E bash '{{.Path}}'"
  }
}
