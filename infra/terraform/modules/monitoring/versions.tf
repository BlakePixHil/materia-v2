terraform {
  required_version = ">= 1.9"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 8.5"
    }
    time = {
      source  = "hashicorp/time"
      version = ">= 0.14"
    }
  }
}
