# RouteWeaver

One inbox for all your agents.

RouteWeaver is an open-source routing layer that puts Hermes, OpenClaw, ACP coding agents, and custom HTTP agents behind one clean entrypoint. Users can send a normal message, use an explicit slash command like `/code`, or let the router choose the right agent from context.

[中文 README](./README.zh-CN.md)

## Why RouteWeaver

Agent stacks quickly become messy:

- Hermes handles personal assistance, reminders, and async work.
- OpenClaw handles workflows, connectors, and desktop automation.
- ACP coding agents handle implementation, debugging, and reviews.
- Cron jobs and agents still need a way to push updates back to users.

RouteWeaver gives those agents a shared front door, shared routing state, and a small control plane.

## What You Get

- Config-driven multi-agent routing with aliases, keyword hints, sticky follow-ups, and optional LLM classification.
- First-class Hermes, OpenClaw, ACP, and custom HTTP backends.
- WeChat and ClawBot ingress, including forwarded image and voice metadata for Hermes backends.
- Internal push delivery for cron jobs, alerts, async task updates, and agent callbacks.
- SQLite-backed bindings, conversations, route decisions, task refs, dedupe, and audit records.
- Agent health checks, restart commands, restart cooldowns, and admin health snapshots.
- Direct per-agent config via `backendUrl`, while still supporting older `backendRef` maps.

## Quick Start

Requirements:

- Node.js 22+
- At least one reachable agent backend

```bash
npm install
cp .env.example .env
npm run check
npm run dev
```

RouteWeaver starts from [`config/router.yaml`](./config/router.yaml). The default sample includes:

- `assistant`: a Hermes main assistant
- `coder`: an ACP coding agent
- `ops`: an OpenClaw automation agent

## Minimal Agent Config

Each agent can own its URLs directly:

```yaml
router:
  defaultMainAgentId: assistant
  stickyAgentWindowMinutes: 180
  heartbeat:
    enabled: true
    intervalMs: 30000
  classifier:
    enabled: true
    provider: openai-compatible
    model: gpt-4.1-mini
    timeoutMs: 2500
    maxRecentTurns: 6
    minConfidenceDirect: 0.85
    minConfidenceKeepActive: 0.7
    minMarginDirect: 0.15
    clarifyBelow: 0.55

agents:
  - agentId: assistant
    displayName: Hermes Assistant
    description: General assistant for planning and async tasks.
    backendKind: hermes
    backendUrl: http://127.0.0.1:8788/hermes-router/message
    aliases: [main, assistant]
    capabilityTags: [assistant, planning, tasks]
    keywordHints: [plan, schedule, todo, reminder]
    pushCategories: [assistant_alert]
    listed: true
    enabled: true
    isMain: true
    riskLevel: low
    healthCheck:
      enabled: true
      healthUrl: http://127.0.0.1:8788/health
      timeoutMs: 3000
      failureThreshold: 2
      restartCommand: hermes gateway restart
      restartTimeoutMs: 20000
      restartCooldownMs: 60000
```

Prefer a central backend map? This still works:

```yaml
backends:
  endpointByRef:
    hermes-main: http://127.0.0.1:8788/hermes-router/message

agents:
  - agentId: assistant
    backendKind: hermes
    backendRef: hermes-main
```

## Routing Model

RouteWeaver combines deterministic and semantic routing:

- Explicit aliases: `/code`, `/ops`, `/assistant`
- Sticky follow-ups: once a conversation is routed, ordinary replies keep going to that agent for a configurable window
- Keyword and capability hints
- Optional LLM classifier with confidence and margin thresholds
- Main-agent fallback when confidence is low

## Operations

List configured agents:

```bash
curl http://127.0.0.1:3000/admin/agents
```

Check heartbeat snapshots:

```bash
curl http://127.0.0.1:3000/admin/agents/health
```

Restart an agent through RouteWeaver:

```bash
curl -X POST http://127.0.0.1:3000/admin/agents/assistant/restart \
  -H "authorization: Bearer change-this-internal-push-token"
```

Restarting can use either an HTTP `restartUrl` or a local `healthCheck.restartCommand`, depending on how the agent is configured.

## Useful Endpoints

- `GET /healthz`
- `GET /readyz`
- `GET /admin/agents`
- `GET /admin/agents/health`
- `POST /admin/agents/:agentId/restart`
- `POST /webhooks/wechat`
- `POST /webhooks/clawbot`
- `POST /internal/push`
- `POST /internal/tasks/action`

## Project Layout

```text
src/
  backends/       Hermes, OpenClaw, ACP, and HTTP adapters
  channels/       WeChat, ClawBot, and outbound delivery
  classifier/     LLM classifier prompt, parser, and providers
  config/         YAML loading and validation
  domain/         core router types and commands
  observability/  audit and logging hooks
  push/           internal push delivery
  router/         routing policy and orchestration
  server/         Fastify app, admin API, and agent monitor
  store/          SQLite repository and schema
  tasks/          async task references
test/             config, routing, webhook, backend, and monitor tests
docs/             technical notes
```

## Docs

- Chinese README: [README.zh-CN.md](./README.zh-CN.md)
- Technical design: [docs/hermes-router-technical-design.md](./docs/hermes-router-technical-design.md)
- ClawBot usage: [docs/clawbot-usage.zh-CN.md](./docs/clawbot-usage.zh-CN.md)
- Hermes cron via router: [docs/hermes-cron-via-router.zh-CN.md](./docs/hermes-cron-via-router.zh-CN.md)

## License

MIT. See [LICENSE](./LICENSE).
