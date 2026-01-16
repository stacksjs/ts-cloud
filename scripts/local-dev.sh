#!/usr/bin/env bash

# Local development environment setup script
# Starts all required services for local AWS development

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Starting ts-cloud local development environment...${NC}"

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
  echo -e "${RED}Error: Docker is not running${NC}"
  echo "Please start Docker and try again"
  exit 1
fi

# Check if docker-compose is installed
if ! command -v docker-compose &> /dev/null; then
  echo -e "${YELLOW}Warning: docker-compose not found, using 'docker compose' instead${NC}"
  DOCKER_COMPOSE="docker compose"
else
  DOCKER_COMPOSE="docker-compose"
fi

# Start services
echo -e "${GREEN}Starting Docker services...${NC}"
$DOCKER_COMPOSE up -d

# Wait for services to be healthy
echo -e "${GREEN}Waiting for services to be ready...${NC}"
sleep 5

# Check service health
check_service() {
  local service=$1
  local port=$2
  local name=$3

  if nc -z localhost $port 2>/dev/null; then
    echo -e "${GREEN}✓${NC} $name is running on port $port"
  else
    echo -e "${RED}✗${NC} $name failed to start on port $port"
  fi
}

check_service "localstack" 4566 "LocalStack"
check_service "postgres" 5432 "PostgreSQL"
check_service "redis" 6379 "Redis"
check_service "dynamodb" 8000 "DynamoDB Local"
check_service "minio" 9000 "MinIO (S3)"
check_service "mailhog" 8025 "MailHog"

echo ""
echo -e "${GREEN}Local development environment is ready!${NC}"
echo ""
echo "Services:"
echo "  - LocalStack (AWS):        http://localhost:4566"
echo "  - PostgreSQL:              postgresql://tscloud:tscloud@localhost:5432/tscloud"
echo "  - Redis:                   redis://localhost:6379"
echo "  - DynamoDB Local:          http://localhost:8000"
echo "  - DynamoDB Admin:          http://localhost:8001"
echo "  - MinIO (S3):              http://localhost:9000"
echo "  - MinIO Console:           http://localhost:9001"
echo "  - MailHog UI:              http://localhost:8025"
echo ""
echo "Environment variables:"
echo "  export TS_CLOUD_LOCAL=true"
echo "  export AWS_ACCESS_KEY_ID=test"
echo "  export AWS_SECRET_ACCESS_KEY=test"
echo "  export AWS_REGION=us-east-1"
echo "  export LOCALSTACK_ENDPOINT=http://localhost:4566"
echo ""
echo -e "${YELLOW}Tip: Run 'source scripts/local-env.sh' to set environment variables${NC}"
