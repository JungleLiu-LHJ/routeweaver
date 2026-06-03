# RouteWeaver

`RouteWeaver` is an open-source agent router for teams that want one clean entrypoint in front of multiple agent runtimes.

It gives first-class support to:

- `Hermes`
- `OpenClaw`
- `ACP` coding agents

It also works with generic HTTP agents.

[中文 README](./README.zh-CN.md)

## Why this exists

Most teams end up with several agents:

- a Hermes assistant for everyday help
- an OpenClaw agent for workflows and connectors
- an ACP coding agent for implementation and debugging

What they usually do not have is a single routing layer that can:

- accept messages from one ingress surface
- decide which agent should handle the turn
- keep short conversation state
- manage async tasks and push callbacks
- expose a unified control plane for restarting agents

That is what RouteWeaver does.

## What it supports

- Multi-agent routing with explicit aliases, keyword hints, and optional LLM classification
- Hermes backends through `/hermes-router/message`
- OpenClaw backends as routable agents
- ACP coding agents as routable agents
- Generic HTTP backends
- WeChat / ClawBot oriented ingress
- SQLite-backed bindings, tasks, conversation state, and audit records
- Admin restart hooks for agents that expose a restart endpoint

## Easy configuration

The default configuration style is intentionally direct: each agent can define its own `backendUrl`, `restartUrl`, and `healthUrl`.

```yaml
agents:
  - agentId: coder
    backendKind: acp
    backendUrl: http://127.0.0.1:8790/message
    restartUrl: http://127.0.0.1:8790/restart
    healthUrl: http://127.0.0.1:8790/health
```

If you already have older configs, `backendRef + backends.endpointByRef` still works.

## Quick start

Requirements:

- Node.js 22+
- one or more reachable agent backends

Run locally:

```bash
npm install
cp .env.example .env
npm run check
npm run dev
```

The default config file is [`config/router.yaml`](./config/router.yaml).

## Included example setup

The sample config shipped in this repo already shows all three major backend types:

- `assistant`: a `Hermes` main assistant
- `coder`: an `ACP` coding agent
- `ops`: an `OpenClaw` automation agent

That makes the repo usable as a public starter instead of a Hermes-only demo.

## Minimal config example

```yaml
storage:
  sqlitePath: .data/routeweaver.sqlite

security:
  allowlist: []
  internalPushToken: change-this-internal-push-token

router:
  defaultMainAgentId: assistant
  stickyAgentWindowMinutes: 180
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
    restartUrl: http://127.0.0.1:8788/hermes-router/restart
    healthUrl: http://127.0.0.1:8788/health
    aliases: [main, assistant]
    capabilityTags: [assistant, planning]
    keywordHints: [plan, travel, reminder]
    pushCategories: [assistant_alert]
    listed: true
    enabled: true
    isMain: true
    riskLevel: low

  - agentId: coder
    displayName: ACP Coding Agent
    description: Coding, debugging, and implementation.
    backendKind: acp
    backendUrl: http://127.0.0.1:8790/message
    restartUrl: http://127.0.0.1:8790/restart
    healthUrl: http://127.0.0.1:8790/health
    aliases: [code, coding, dev]
    capabilityTags: [coding, debugging]
    keywordHints: [bug, fix, test, refactor]
    pushCategories: [coding_alert]
    listed: true
    enabled: true
    riskLevel: medium

  - agentId: ops
    displayName: OpenClaw Ops Agent
    description: Automation, workflows, and integrations.
    backendKind: openclaw
    backendUrl: http://127.0.0.1:8789/message
    restartUrl: http://127.0.0.1:8789/restart
    healthUrl: http://127.0.0.1:8789/health
    aliases: [ops, automation]
    capabilityTags: [ops, automation]
    keywordHints: [deploy, workflow, integration]
    pushCategories: [ops_alert]
    listed: true
    enabled: true
    riskLevel: medium
```

## Restarting agents

If an agent exposes `restartUrl`, RouteWeaver can restart it through one admin API:

```bash
curl -X POST http://127.0.0.1:3000/admin/agents/coder/restart \
  -H "authorization: Bearer change-this-internal-push-token"
```

This matters in real deployments because you do not want a different operational interface for every agent runtime.

## Useful endpoints

- `GET /healthz`
- `GET /readyz`
- `GET /admin/agents`
- `POST /admin/agents/:agentId/restart`
- `POST /webhooks/wechat`
- `POST /webhooks/clawbot`
- `POST /internal/push`
- `POST /internal/tasks/action`

## Routing behavior

Route decisions are made from:

- explicit slash commands such as `/code` or `/ops`
- agent keyword hints and capability tags
- optional LLM classifier output

So users can either force a target agent or let the router choose.

## Project layout

```text
src/
  backends/       backend adapters for Hermes, OpenClaw, ACP, and HTTP agents
  channels/       inbound/outbound channel integrations
  classifier/     LLM classifier contract, prompt, parser, providers
  config/         config loader and validation
  domain/         core router types and command parsing
  observability/  logging and audit hooks
  push/           internal push delivery
  router/         routing policy and orchestration
  server/         Fastify app and bootstrap
  store/          SQLite repository and schema
  tasks/          async task handling
test/             routing and backend tests
docs/             technical notes
```

## Documentation

- Chinese README: [README.zh-CN.md](./README.zh-CN.md)
- Technical design: [docs/hermes-router-technical-design.md](./docs/hermes-router-technical-design.md)
- ClawBot usage: [docs/clawbot-usage.zh-CN.md](./docs/clawbot-usage.zh-CN.md)

## License

This project is released under the `MIT` license. See [LICENSE](./LICENSE).
