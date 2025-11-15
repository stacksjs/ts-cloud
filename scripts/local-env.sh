#!/usr/bin/env bash

# Local development environment variables
# Source this file to set up environment for local AWS development
#
# Usage: source scripts/local-env.sh

export TS_CLOUD_LOCAL=true
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_REGION=us-east-1
export AWS_DEFAULT_REGION=us-east-1
export LOCALSTACK_ENDPOINT=http://localhost:4566
export POSTGRES_URL=postgresql://tscloud:tscloud@localhost:5432/tscloud
export REDIS_URL=redis://localhost:6379
export DYNAMODB_ENDPOINT=http://localhost:8000
export S3_ENDPOINT=http://localhost:9000
export EMAIL_ENDPOINT=smtp://localhost:1025

# MinIO credentials
export MINIO_ROOT_USER=tscloud
export MINIO_ROOT_PASSWORD=tscloud123

echo "✓ Local development environment variables set"
echo "  TS_CLOUD_LOCAL=$TS_CLOUD_LOCAL"
echo "  AWS_REGION=$AWS_REGION"
echo "  LOCALSTACK_ENDPOINT=$LOCALSTACK_ENDPOINT"
