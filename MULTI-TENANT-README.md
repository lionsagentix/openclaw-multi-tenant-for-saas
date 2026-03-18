# OpenClaw Multi-Tenant for SaaS

**A multi-tenant SaaS extension of [OpenClaw](https://github.com/openclaw/openclaw), primarily developed for [mark8place.com](https://mark8place.com).**

[![Upstream](https://img.shields.io/badge/upstream-openclaw%2Fopenclaw-blue?style=for-the-badge)](https://github.com/openclaw/openclaw)
[![License](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)

---

## Overview

OpenClaw is a personal AI assistant gateway designed for single-operator deployments. This fork extends it into a **multi-tenant SaaS platform** where mutually untrusted tenants (separate organizations) are fully isolated, each receiving their own dedicated gateway instance orchestrated by a centralized control plane.

This architecture follows OpenClaw's own security guidance from [`SECURITY.md`](SECURITY.md):

> "A single Gateway shared by mutually untrusted people is NOT a recommended setup. Use separate gateways (or at minimum separate OS users/hosts) per trust boundary."

Rather than retrofitting tenant isolation into the gateway internals, this fork adds a **control plane layer** on top of unmodified OpenClaw gateways, achieving full tenant isolation through container-level separation.

---

## Architecture

```
                    +------------------------------+
                    |    Platform Control Plane     |
                    |                               |
                    |  Tenant CRUD + Provisioning   |
                    |  Gateway Orchestrator         |
                    |  Billing Engine (Agnostic)    |
                    |  Usage Collector + Metering   |
                    |  Quota Enforcement            |
                    |  Platform REST API            |
                    |  PostgreSQL State Store       |
                    +------+---------+--------+----+
                           |         |        |
              +------------+    +----+---+    +------------+
              |                 |         |                |
     +--------v--------+ +-----v-----+ +-v--------------+
     |  Tenant A GW    | | Tenant B  | |  Tenant C GW   |
     |  (K8s Pod)      | | (K8s Pod) | |  (K8s Pod)     |
     |                 | |           | |                 |
     |  Own config     | | Own config| |  Own config     |
     |  Own agents     | | Own agents| |  Own agents     |
     |  Own sessions   | | Own sess. | |  Own sessions   |
     |  Own memory DB  | | Own mem.  | |  Own memory DB  |
     |  Own auth keys  | | Own auth  | |  Own auth keys  |
     +-----------------+ +-----------+ +-----------------+
```

### Key Design Principles

1. **Zero gateway modifications** -- All existing OpenClaw gateway code runs unmodified inside each tenant's container. Agent scoping, routing, sessions, memory, and plugins work exactly as in single-tenant deployments.

2. **Container-level isolation** -- Each tenant gets a dedicated Kubernetes pod with its own filesystem (PersistentVolumeClaim), network namespace, and resource limits. No shared state between tenants.

3. **Payment-provider-agnostic billing** -- The billing system is built on an abstract `BillingProvider` interface. Swap between Stripe, Paddle, LemonSqueezy, or custom providers without changing business logic.

4. **Kubernetes-native at scale** -- Designed for 500+ tenants from day one with tenant hibernation, container pre-warming, and per-plan resource tiering.

5. **Flexible AI credential management** -- Tenants can bring their own API keys (BYOK), use platform-provided AI access (metered and billed), or both (hybrid with automatic failover).

---

## What This Fork Adds

All additions are in new modules -- no existing OpenClaw files are modified.

| Module | Purpose |
|--------|---------|
| `src/tenants/` | Tenant management -- CRUD, provisioning, lifecycle, config generation |
| `src/control-plane/` | Gateway orchestrator, health monitoring, usage collection, quota enforcement, hibernation, warm pool |
| `src/billing/` | Payment-provider-agnostic billing -- subscriptions, usage metering, webhooks, invoicing |
| `deploy/kubernetes/` | Kubernetes manifests for control plane, tenant templates, ingress, and database |

### New Capabilities

- **Tenant Provisioning** -- Create a tenant via API, and a fully configured, hardened OpenClaw gateway spins up in under 1 second (via warm container pool)
- **Tenant Hibernation** -- Inactive tenants are automatically hibernated (container stopped, volume preserved). Wake on first inbound message in <1 second
- **Usage Metering** -- AI token consumption tracked per tenant, per model, per day. Reported to billing provider for usage-based invoicing
- **Quota Enforcement** -- Per-plan limits on messages/day, tokens/day, cost/month, agents, channels, and storage
- **Resource Tiering** -- Kubernetes resource requests/limits configured per plan tier (Free through Enterprise)
- **Warm Container Pool** -- Pre-started gateway containers ready to be claimed, eliminating cold-start latency
- **Health Monitoring** -- Continuous gateway health checks with auto-restart and admin alerting
- **Audit Logging** -- All tenant management operations logged for compliance

---

## Security Model

Each tenant gateway is provisioned with hardened configuration following OpenClaw's multi-user remediation guidance:

| Setting | Value | Purpose |
|---------|-------|---------|
| `agents.defaults.sandbox.mode` | `"all"` | Full execution sandboxing |
| `tools.fs.workspaceOnly` | `true` | Filesystem restricted to workspace |
| `tools.exec.applyPatch.workspaceOnly` | `true` | Patch tool restricted to workspace |
| `gateway.auth.mode` | `"token"` | Token-based gateway authentication |

Additional container-level hardening:

- Runs as non-root user (`node`, UID 1000)
- `--cap-drop=ALL` on containers
- Kubernetes `NetworkPolicy` restricts egress to AI provider APIs and the control plane only
- Per-container CPU and memory limits prevent resource exhaustion
- Read-only root filesystem where possible

---

## Billing Provider Interface

All billing code interacts through an abstract interface, never with a specific payment provider directly:

```typescript
interface BillingProvider {
  // Customer lifecycle
  createCustomer(params): Promise<BillingCustomer>;
  getCustomer(externalId): Promise<BillingCustomer | null>;

  // Subscription management
  createSubscription(params): Promise<BillingSubscription>;
  cancelSubscription(subscriptionId, params?): Promise<void>;
  changeSubscriptionPlan(subscriptionId, newPlanId): Promise<BillingSubscription>;

  // Usage-based billing
  reportUsage(params): Promise<void>;

  // Invoicing
  getUpcomingInvoice(customerId): Promise<BillingInvoice | null>;
  listInvoices(customerId, params?): Promise<BillingInvoice[]>;

  // Webhook verification
  verifyWebhookSignature(payload, signature): boolean;
  parseWebhookEvent(payload): BillingWebhookEvent;
}
```

**Included implementations:**
- Stripe (full implementation)
- Paddle (stub, interface-compliant)
- LemonSqueezy (stub, interface-compliant)

---

## AI Credential Modes

Each tenant can be configured with one of three credential modes:

| Mode | Description | Metered? |
|------|-------------|----------|
| **BYOK** | Tenant provides their own AI provider API keys | No -- tenant pays provider directly |
| **Platform** | Platform operator provides shared AI keys | Yes -- usage billed to tenant |
| **Hybrid** | Tenant keys with platform fallback | Only platform key usage is metered |

In hybrid mode, the existing OpenClaw auth profile round-robin and cooldown system handles automatic failover from tenant keys to platform keys.

---

## Performance at Scale

Designed for 500+ tenants with resource efficiency:

| Metric | Value |
|--------|-------|
| Per-tenant message latency | Same as single-tenant (~50-200ms) |
| Cold start / wake from hibernation | <1 second (warm pool) |
| Memory per active tenant | ~150-300 MB |
| Memory per hibernated tenant | ~0 MB (container stopped) |

**At 500 tenants (70% idle at any time):**
- Active containers: ~150
- Warm pool: 10-20 standby containers
- Total RAM: ~30-60 GB
- Kubernetes nodes: 3-5 (depending on instance size)

### Resource Tiers

| Plan | CPU | Memory | Hibernation |
|------|-----|--------|-------------|
| Free | 250m (burst 500m) | 128Mi (limit 256Mi) | After 30 min idle |
| Starter | 500m (burst 1000m) | 256Mi (limit 512Mi) | After 2 hours idle |
| Pro | 1000m (burst 2000m) | 512Mi (limit 1Gi) | After 4 hours idle |
| Enterprise | 2000m (burst 4000m) | 2Gi (limit 4Gi) | Never (always active) |

---

## Technology Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 22+ / TypeScript (ESM) |
| Gateway | OpenClaw (unmodified upstream) |
| Control Plane DB | PostgreSQL |
| Container Orchestration | Kubernetes (primary), Docker (dev/fallback) |
| Billing | Provider-agnostic (Stripe, Paddle, LemonSqueezy) |
| Ingress | nginx-ingress / Traefik |
| Package Manager | pnpm |

---

## Getting Started

### Prerequisites

- Node.js 22+
- pnpm
- PostgreSQL 16+
- Kubernetes cluster (or `kind` for local development)
- Docker (for building images)

### Local Development

```bash
# Clone the fork
git clone https://github.com/lionsagentix/openclaw-multi-tenant-for-saas.git
cd openclaw-multi-tenant-for-saas

# Install dependencies
pnpm install

# Start local PostgreSQL
docker run -d --name openclaw-pg -p 5432:5432 \
  -e POSTGRES_DB=openclaw_control_plane \
  -e POSTGRES_USER=openclaw \
  -e POSTGRES_PASSWORD=dev \
  postgres:16

# Run database migrations
openclaw control-plane migrate

# Start the control plane
openclaw control-plane run

# Create your first tenant
openclaw control-plane tenant create \
  --slug my-tenant \
  --email admin@example.com \
  --plan starter
```

### Production Deployment

See `deploy/kubernetes/` for production Kubernetes manifests including:
- Control plane Deployment + Service
- PostgreSQL StatefulSet (or use managed DB)
- Per-tenant resource templates
- Ingress routing configuration
- NetworkPolicy for tenant isolation

---

## Upstream Relationship

This fork tracks the `main` branch of [`openclaw/openclaw`](https://github.com/openclaw/openclaw).

**Sync strategy:**
- All multi-tenancy code lives in new modules (`src/tenants/`, `src/control-plane/`, `src/billing/`, `deploy/`)
- No existing OpenClaw gateway files are modified
- Upstream merges are expected to be conflict-free
- Periodic sync: `git fetch upstream && git merge upstream/main`

**Upstream remote:**
```bash
git remote add upstream https://github.com/openclaw/openclaw.git
```

---

## Control Plane API

### Admin Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/tenants` | Create tenant + trigger provisioning |
| `GET` | `/api/v1/tenants` | List tenants (paginated) |
| `GET` | `/api/v1/tenants/:id` | Get tenant details |
| `PATCH` | `/api/v1/tenants/:id` | Update tenant config/plan |
| `POST` | `/api/v1/tenants/:id/suspend` | Suspend tenant |
| `POST` | `/api/v1/tenants/:id/resume` | Resume tenant |
| `DELETE` | `/api/v1/tenants/:id` | Decommission tenant |

### Tenant Self-Service Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/tenant/usage` | Current usage summary |
| `GET` | `/api/v1/tenant/billing` | Billing status + invoices |
| `POST` | `/api/v1/tenant/credentials` | Upload BYOK API keys |
| `DELETE` | `/api/v1/tenant/credentials/:id` | Remove a BYOK key |
| `GET` | `/api/v1/tenant/gateway/status` | Gateway health status |

### Webhooks

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/webhooks/billing` | Payment provider webhook (signature-verified) |

---

## Implementation Phases

| Phase | Scope | Status |
|-------|-------|--------|
| 0. Setup | Fork, dependencies, Dockerfile, K8s manifests | Planned |
| 1. Foundation | Tenant types, DB schema, tenant store, config generator | Planned |
| 2. Orchestration | K8s container runtime, orchestrator, health monitor | Planned |
| 3. Billing | Provider interface, Stripe impl, webhooks, quotas | Planned |
| 4. Usage & Credentials | Usage collector, BYOK API, hybrid mode, metering | Planned |
| 5. API & CLI | Control plane server, REST endpoints, CLI commands | Planned |
| 6. Scaling | Hibernation, warm pool, resource tiering | Planned |
| 7. Polish | Audit logging, monitoring, load testing, docs | Planned |

---

## License

MIT -- see [LICENSE](LICENSE) for details.

This project is a fork of [OpenClaw](https://github.com/openclaw/openclaw), originally created by Peter Steinberger. All original OpenClaw code retains its MIT license and copyright.

---

## Credits

- [OpenClaw](https://github.com/openclaw/openclaw) -- the upstream personal AI assistant gateway
- [mark8place.com](https://mark8place.com) -- primary deployment target for this multi-tenant extension
- Built by [LionsAgentix](https://github.com/lionsagentix)
