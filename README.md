# RouteWeaver

One WeChat thread. Multiple Hermes specialists.

RouteWeaver is a lightweight router that sits in front of your Hermes profiles. It lets users talk naturally in WeChat, jump to a specialist with a slash command, and keep follow-up turns pinned to the right Hermes agent.

[中文 README](./README.zh-CN.md)

## Supported Today

- WeChat ingress
- Hermes backends
- Natural chat, slash routing, sticky follow-ups
- Internal push for async Hermes results
- Health checks and restart commands for local Hermes profiles

## How It Feels

Users do not need to think about ports or profiles.

- Send a normal message and RouteWeaver sends it to the main Hermes agent
- Use `/news`, `/life`, or `/finance` to switch explicitly
- Keep replying naturally and the conversation stays with that agent for a configurable window
- Let long-running Hermes work finish asynchronously and push back through the router

Examples:

- `明天去上海，帮我排个行程`
- `/news summarize today's AI news`
- `/finance 帮我看下这个月支出`

## Quick Start

Requirements:

- Node.js 22+
- Running Hermes profiles reachable by HTTP

```bash
npm install
cp .env.example .env
npm run check
npm run dev
```

RouteWeaver reads [`config/router.yaml`](./config/router.yaml).

## Default Interaction Model

The sample config exposes three Hermes agents:

- `news`: current events, public information, briefings
- `life`: daily planning, travel, routines, personal logistics
- `finance`: budgets, bills, spending, investments

The default agent is `life`.

## Minimal Config Shape

```yaml
backends:
  endpointByRef:
    hermes-news: http://127.0.0.1:8788/hermes-router/message
    hermes-life: http://127.0.0.1:8789/hermes-router/message
    hermes-finance: http://127.0.0.1:8790/hermes-router/message

router:
  defaultMainAgentId: life
  stickyAgentWindowMinutes: 180

agents:
  - agentId: news
    displayName: News Hermes
    backendKind: hermes
    backendRef: hermes-news
    aliases: [news]
    enabled: true
    listed: true
    riskLevel: low

  - agentId: life
    displayName: Life Hermes
    backendKind: hermes
    backendRef: hermes-life
    aliases: [life, travel, trip]
    enabled: true
    listed: true
    isMain: true
    riskLevel: low

  - agentId: finance
    displayName: Finance Hermes
    backendKind: hermes
    backendRef: hermes-finance
    aliases: [finance, finances]
    enabled: true
    listed: true
    riskLevel: medium
```

## Operations

```bash
curl http://127.0.0.1:3000/admin/agents
curl http://127.0.0.1:3000/admin/agents/health
curl -X POST http://127.0.0.1:3000/admin/agents/life/restart \
  -H "authorization: Bearer change-this-internal-push-token"
```

Useful endpoints:

- `GET /healthz`
- `GET /readyz`
- `GET /admin/agents`
- `GET /admin/agents/health`
- `POST /admin/agents/:agentId/restart`
- `POST /webhooks/wechat`
- `POST /internal/push`
- `POST /internal/tasks/action`

## Why This Version

This public repo is intentionally focused.

- One channel: WeChat
- One backend family: Hermes
- One job: route users to the right assistant cleanly

That keeps the setup small, understandable, and useful on day one.

## License

MIT. See [LICENSE](./LICENSE).
