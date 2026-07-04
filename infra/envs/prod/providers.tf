terraform {
  # use_lockfile(S3ネイティブロック)は1.11系で正式化
  required_version = ">= 1.11.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # bucketはCIが -backend-config で注入する(パブリックリポジトリにアカウント固有値を置かない)
  backend "s3" {
    key          = "prod/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = "us-east-1"

  default_tags {
    tags = {
      Project     = "aws-mon"
      Environment = "prod"
      ManagedBy   = "terraform"
    }
  }
}
