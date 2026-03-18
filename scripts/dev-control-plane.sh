#!/usr/bin/env bash
# dev-control-plane.sh — Start local development infrastructure for the multi-tenant control plane.
#
# Usage:
#   ./scripts/dev-control-plane.sh        # Start PostgreSQL + run migrations
#   ./scripts/dev-control-plane.sh stop   # Stop PostgreSQL
#   ./scripts/dev-control-plane.sh reset  # Stop, remove data, and restart fresh
#
# Prerequisites:
#   - Docker (for PostgreSQL container)
#   - Node.js 22+ and pnpm
#
# Optional (for full K8s testing):
#   - kind (Kubernetes in Docker): https://kind.sigs.k8s.io
#   - kubectl

set -euo pipefail

POSTGRES_CONTAINER="openclaw-cp-postgres"
POSTGRES_PORT=5432
POSTGRES_DB="openclaw_control_plane"
POSTGRES_USER="openclaw"
POSTGRES_PASSWORD="dev-password-not-for-production"

export DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:${POSTGRES_PORT}/${POSTGRES_DB}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() { echo -e "${GREEN}[control-plane]${NC} $1"; }
warn() { echo -e "${YELLOW}[control-plane]${NC} $1"; }
error() { echo -e "${RED}[control-plane]${NC} $1" >&2; }

check_docker() {
  if ! command -v docker &>/dev/null; then
    error "Docker is required but not installed. Install from https://docker.com"
    exit 1
  fi
  if ! docker info &>/dev/null; then
    error "Docker daemon is not running. Please start Docker."
    exit 1
  fi
}

start_postgres() {
  if docker ps --format '{{.Names}}' | grep -q "^${POSTGRES_CONTAINER}$"; then
    log "PostgreSQL is already running."
    return 0
  fi

  if docker ps -a --format '{{.Names}}' | grep -q "^${POSTGRES_CONTAINER}$"; then
    log "Starting existing PostgreSQL container..."
    docker start "${POSTGRES_CONTAINER}"
  else
    log "Creating and starting PostgreSQL 16..."
    docker run -d \
      --name "${POSTGRES_CONTAINER}" \
      -p "${POSTGRES_PORT}:5432" \
      -e POSTGRES_DB="${POSTGRES_DB}" \
      -e POSTGRES_USER="${POSTGRES_USER}" \
      -e POSTGRES_PASSWORD="${POSTGRES_PASSWORD}" \
      -v "openclaw-cp-pgdata:/var/lib/postgresql/data" \
      postgres:16-bookworm
  fi

  log "Waiting for PostgreSQL to be ready..."
  local retries=30
  while ! docker exec "${POSTGRES_CONTAINER}" pg_isready -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" &>/dev/null; do
    retries=$((retries - 1))
    if [ "$retries" -eq 0 ]; then
      error "PostgreSQL failed to start within 30 seconds."
      exit 1
    fi
    sleep 1
  done
  log "PostgreSQL is ready at localhost:${POSTGRES_PORT}"
}

stop_postgres() {
  if docker ps --format '{{.Names}}' | grep -q "^${POSTGRES_CONTAINER}$"; then
    log "Stopping PostgreSQL..."
    docker stop "${POSTGRES_CONTAINER}"
    log "PostgreSQL stopped."
  else
    warn "PostgreSQL is not running."
  fi
}

reset_postgres() {
  stop_postgres
  if docker ps -a --format '{{.Names}}' | grep -q "^${POSTGRES_CONTAINER}$"; then
    log "Removing PostgreSQL container..."
    docker rm "${POSTGRES_CONTAINER}"
  fi
  if docker volume ls --format '{{.Name}}' | grep -q "^openclaw-cp-pgdata$"; then
    log "Removing PostgreSQL data volume..."
    docker volume rm openclaw-cp-pgdata
  fi
  log "PostgreSQL reset complete. Run this script again to start fresh."
}

run_migrations() {
  if [ -d "src/control-plane/migrations" ] && ls src/control-plane/migrations/*.sql &>/dev/null 2>&1; then
    log "Running database migrations..."
    # Migrations will be run by the control plane CLI once implemented.
    # For now, apply SQL files directly.
    for migration in src/control-plane/migrations/*.sql; do
      log "  Applying $(basename "$migration")..."
      docker exec -i "${POSTGRES_CONTAINER}" \
        psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" < "$migration"
    done
    log "Migrations complete."
  else
    warn "No migration files found in src/control-plane/migrations/. Skipping."
  fi
}

print_env() {
  echo ""
  log "Development environment ready."
  echo ""
  echo "  DATABASE_URL=${DATABASE_URL}"
  echo "  CONTROL_PLANE_ADMIN_KEY=dev-admin-key"
  echo ""
  echo "  To start the control plane:"
  echo "    DATABASE_URL=\"${DATABASE_URL}\" CONTROL_PLANE_ADMIN_KEY=dev-admin-key \\"
  echo "      pnpm openclaw control-plane run"
  echo ""
}

# ── Main ────────────────────────────────────────────────────────

case "${1:-start}" in
  start)
    check_docker
    start_postgres
    run_migrations
    print_env
    ;;
  stop)
    stop_postgres
    ;;
  reset)
    check_docker
    reset_postgres
    start_postgres
    run_migrations
    print_env
    ;;
  *)
    echo "Usage: $0 {start|stop|reset}"
    exit 1
    ;;
esac
