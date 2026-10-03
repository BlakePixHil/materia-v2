terraform {
  required_version = ">= 1.9"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.5"
    }
  }

  # The bootstrap stack keeps local state: it creates the bucket every other stack uses.
  # Keep terraform.tfstate out of git (see .gitignore) and store a copy with the owner.
}
