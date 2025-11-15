#!/usr/bin/env bash

# Stop local development environment
# Stops all Docker services

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Stopping TS Cloud local development environment...${NC}"

# Check if docker-compose is installed
if ! command -v docker-compose &> /dev/null; then
  echo -e "${YELLOW}Warning: docker-compose not found, using 'docker compose' instead${NC}"
  DOCKER_COMPOSE="docker compose"
else
  DOCKER_COMPOSE="docker-compose"
fi

# Stop services
$DOCKER_COMPOSE down

echo -e "${GREEN}Local development environment stopped${NC}"
