# Hermes Router Technical Design

`hermes-router` is a standalone TypeScript + Node.js 22 service that fronts user-facing channels, decides which configured agent should handle a message, and dispatches the message to independent backends such as Hermes profiles, ACP, or custom HTTP agents.

The important boundary is directional:

```text
External channel -> hermes-router -> backend agent/profile
```

For `hermes-router`, WeChat is a channel and Hermes is a backend. For Hermes, `hermes-router` is implemented as a native platform adapter named `hermes_router`. This lets Hermes receive routed user messages through its gateway platform pipeline without knowing whether the original source was WeChat, Telegram, Web, or another future channel.

## Implemented Shape

- `src/server`: Fastify bootstrap, public/internal/admin endpoints, WeChat webhook orchestration
- `src/config`: YAML loading and Zod validation for storage, security, backend endpoints, WeChat binding, router thresholds, and agent profiles
- `src/domain`: stable router types, backend response contract, binding/task/confirmation types, command parsing
- `src/channels/wechat`: inbound/outbound adapter for the MVP external channel
- `src/backends`: backend adapter contract and HTTP-backed implementations for Hermes/ACP/custom HTTP
- `src/router`: routing pipeline plus composite decision policy
- `src/classifier`: provider contract, prompt builder, structured parser, OpenAI-compatible classifier
- `src/store`: SQLite repository plus Drizzle schema scaffold
- `src/push`: authenticated internal push acceptance, mute/category/dedupe checks
- `src/tasks`: task listing, status update, and stop workflow
- `src/observability`: audit writer abstraction and SQLite audit events

## Routing Model

Agents are configured in `config/router.yaml`. Each agent declares:

- `agentId`: router-local identity
- `displayName`: user-facing name
- `description`: primary semantic routing description
- `backendKind`: `hermes`, `acp`, or `custom-http`
- `backendRef`: lookup key into `backends.endpointByRef`
- `aliases`: explicit slash-command names
- `capabilityTags`, `keywordHints`, `scenarioHints`: routing hints
- `pushCategories`: allowed push categories for that agent

Explicit aliases always win. For example, `/finance ...` routes to the agent whose aliases include `finance`.

When the user does not explicitly select an agent, the router scores configured agents using:

- active conversation continuity
- keyword hints
- scenario hints
- description and capability text
- optional LLM classifier output
- recent correction penalties

This means adding a Hermes profile is mostly configuration: add one `agents[]` entry with a good `description`, then map its `backendRef` to an endpoint.

## Hermes Profiles As Backends

Multiple Hermes profiles should be represented as multiple configured router agents:

```yaml
backends:
  endpointByRef:
    hermes-news: http://127.0.0.1:8788/hermes-router/message
    hermes-life: http://127.0.0.1:8789/hermes-router/message
    hermes-finance: http://127.0.0.1:8790/hermes-router/message

agents:
  - agentId: news
    displayName: News Hermes
    description: News, current events, market headlines, public information lookup, and briefings.
    backendKind: hermes
    backendRef: hermes-news
    aliases: [news]
    capabilityTags: [news, current-events]
    keywordHints: [news, headline, briefing]
    pushCategories: [news_alert]
    listed: true
    enabled: true
    riskLevel: low

  - agentId: life
    displayName: Life Hermes
    description: Personal life planning, routines, travel, home, errands, relationships, and daily logistics.
    backendKind: hermes
    backendRef: hermes-life
    aliases: [life, main]
    capabilityTags: [life, personal]
    keywordHints: [travel, routine, home, errand]
    pushCategories: [life_alert]
    listed: true
    enabled: true
    isMain: true
    riskLevel: low

  - agentId: finance
    displayName: Finance Hermes
    description: Personal finance, budgets, spending, bills, investment tracking.
    backendKind: hermes
    backendRef: hermes-finance
    aliases: [finance, finances]
    capabilityTags: [finance, budgeting]
    keywordHints: [budget, bill, spending, investment]
    scenarioHints: [monthly budget, bill tracking, portfolio review]
    pushCategories: [finance_alert]
    listed: true
    enabled: true
    riskLevel: medium
```

The router does not need a separate external channel per Hermes profile. One external channel, such as WeChat, can route into many Hermes profiles.

## Direct WeChat ClawBot Channel

The target WeChat integration is direct ClawBot connectivity:

```text
WeChat ClawBot -> hermes-router -> router policy -> Hermes profiles
```

This is separate from OpenClaw. `hermes-router` should not require an OpenClaw runtime or OpenClaw plugin to bind WeChat.

The current `/webhooks/clawbot` endpoint is an HTTP-forward compatibility mode. It is useful when another trusted ClawBot bridge can POST normalized inbound messages into the router, but it does not perform ClawBot login, QR binding, long-poll receive, or active WeChat sending by itself.

Direct ClawBot support should be implemented as a channel adapter:

```text
src/channels/clawbot/
  adapter.ts        # parse inbound ClawBot events and format outbound sends
  client.ts         # login, QR status, receive loop, send text
  session-store.ts  # encrypted or file-backed ClawBot session persistence
```

Configuration:

```yaml
wechat:
  mode: clawbot
  clawbot:
    enabled: true
    sessionPath: .data/clawbot-session.json
    pollIntervalMs: 1000
    bindQrTtlSeconds: 300
```

Admin/runtime endpoints:

```text
POST /admin/clawbot/login
GET  /admin/clawbot/status
POST /admin/clawbot/logout
```

Runtime flow:

1. Admin calls `/admin/clawbot/login`.
2. Router asks the ClawBot client for a login QR or bind scene.
3. User scans in WeChat.
4. Router persists the ClawBot session and starts receiving messages.
5. Incoming ClawBot text is normalized into `InboundMessage`.
6. Router applies binding, allowlist, dedupe, commands, routing, backend dispatch, and audit.
7. Router sends the assistant text back through the same ClawBot client.

If official ClawBot exposes only a Node SDK, wrap that SDK in `client.ts`. If it exposes HTTP/WebSocket APIs, keep the client as a small typed HTTP/WebSocket wrapper. The rest of the router should continue to depend only on the `InboundMessage` and outbound text abstractions.

## Hermes-Router As A Hermes Channel

Although Hermes profiles are modeled as backends inside `hermes-router`, the Hermes side treats `hermes-router` as a native platform/channel adapter.

Conceptually:

```text
WeChat / future channels
  -> hermes-router channel adapters
  -> router policy
  -> HermesBackendAdapter
  -> Hermes "hermes_router" platform adapter
  -> selected Hermes profile
```

This keeps channel concerns out of Hermes profiles:

- Hermes does not parse WeChat payloads.
- Hermes does not manage WeChat binding, allowlists, dedupe, push mutes, or slash-command routing.
- Hermes sees a normalized message from a channel named `hermes-router`.
- Hermes can still preserve the original source channel and user identity in metadata.

### Hermes-Side Adapter

The Hermes repo provides a bundled platform plugin:

```text
plugins/platforms/hermes_router/
  plugin.yaml
  adapter.py
```

It exposes:

```text
GET  /health
POST /hermes-router/message
```

Each Hermes profile runs its own adapter listener. The adapter receives the router backend request, converts it into Hermes' native `MessageEvent`, and lets that profile's Hermes gateway runner process the turn.

Router-to-adapter request:

```json
{
  "responseMode": "async",
  "profile": "finance",
  "agentId": "finance",
  "message": "帮我看下这个月预算",
  "conversationId": "wechat:o123",
  "userId": "o123",
  "sourceChannel": "wechat",
  "activeAgentId": "finance",
  "topicSummary": "monthly budget discussion",
  "scenarioLabel": "budget review",
  "confirmationRef": null,
  "confirmed": false
}
```

Adapter-to-Hermes message:

```json
{
  "channel": "hermes_router",
  "profile": "finance",
  "externalUserId": "wechat:o123",
  "conversationId": "wechat:o123",
  "text": "帮我看下这个月预算",
  "metadata": {
    "sourceChannel": "wechat",
    "routerAgentId": "finance",
    "activeAgentId": "finance",
    "scenarioLabel": "budget review"
  }
}
```

Hermes-to-router response:

```json
{
  "content": "已提交给 Finance Hermes，完成后会推送结果。",
  "taskRef": "hermes-task-id",
  "taskStatus": "queued",
  "requiresConfirmation": false,
  "confirmationText": null,
  "confirmationRef": null
}
```

The response fields are intentionally router-owned:

- `content`: text returned to the original channel
- `taskRef`: long-running task handle stored by router
- `taskStatus`: initial task state
- `requiresConfirmation`: pauses high-risk operations
- `confirmationText`: prompt shown to the user
- `confirmationRef`: backend continuation handle

Hermes submissions use a short 3000 ms timeout. The timeout only covers enqueueing work in the Hermes adapter; inference, tool execution, and final channel delivery must happen asynchronously through the router return path.

Runtime configuration:

```text
HERMES_ROUTER_ADAPTER_TOKEN=...
HERMES_ROUTER_ADAPTER_HOST=127.0.0.1
HERMES_ROUTER_ADAPTER_PORT=8788
HERMES_ROUTER_URL=http://127.0.0.1:3000
HERMES_ROUTER_TOKEN=<router internalPushToken>
HERMES_ROUTER_HOME_CHANNEL=<wechat user id>
```

### Why Not Make Each Hermes Profile A Router Channel?

Do not model `news`, `life`, or `finance` as router channels. Channels represent ingress surfaces and external identity systems. Profiles represent execution targets.

The same WeChat user may switch between many Hermes profiles in one conversation:

```text
/finance 看预算
/life 安排周末行程
/news 今天有什么重要新闻
```

All three messages still came from the same external channel and the same channel identity. The selected Hermes profile changes, but the source channel does not.

## Backend Contract

Generic HTTP backends use the existing router contract. Hermes backends use the native `hermes_router` adapter contract. The router sends:

```json
{
  "responseMode": "async",
  "profile": "finance",
  "agentId": "finance",
  "message": "帮我看下预算",
  "conversationId": "wechat:o123",
  "userId": "o123",
  "sourceChannel": "wechat",
  "activeAgentId": "finance",
  "topicSummary": null,
  "scenarioLabel": "budget review",
  "confirmationRef": null,
  "confirmed": false
}
```

The backend returns:

```json
{
  "content": "已提交给 Finance Hermes，完成后会推送结果。",
  "taskRef": "hermes-task-id",
  "taskStatus": "queued",
  "requiresConfirmation": false,
  "confirmationText": null,
  "confirmationRef": null
}
```

Hermes-specific behavior lives behind `HermesBackendAdapter` and the Hermes-side `hermes_router` platform adapter. The rest of the router continues to depend only on the generic backend response shape.

## Message Flow

1. WeChat webhook receives an inbound message.
2. Router dedupes by external message id.
3. Router handles `/bind <token>` before normal authorization.
4. Router checks allowlist and channel binding.
5. Router persists the user turn.
6. Router handles built-in commands such as `/main`, `/status`, `/reset`, `/agents`, `/push`, and `/tasks`.
7. Router blocks on pending high-risk confirmation when one exists.
8. Router decides the target agent from explicit alias, continuity, description/hints, and optional classifier.
9. Router dispatches to the selected backend endpoint. Hermes backends are submitted with `responseMode: "async"` and should return quickly with a task reference.
10. Router stores assistant turn, task refs, pending confirmations, route decisions, and audit events.
11. Router formats the response back to the external channel.

## Push And Task Return Path

Backends should not send directly to WeChat. They should call router internal endpoints:

```text
POST /internal/push
POST /internal/tasks/action
```

The router owns:

- bearer-token auth
- push category validation
- mute checks
- dedupe keys
- binding checks
- audit events
- final outbound channel delivery

This keeps Hermes profiles channel-agnostic even when they produce async task completion messages or proactive alerts.

### Hermes Cron To WeChat Through Router

Hermes cron jobs should also use the same internal push path instead of sending to WeChat directly:

```text
Hermes profile cron -> POST /internal/push -> hermes-router policy -> ClawBot -> WeChat
```

Recommended category mapping:

- `news` profile cron -> `news_alert`
- `life` profile cron -> `life_alert` or `travel_alert`
- `finance` profile cron -> `finance_alert`

Example request:

```json
{
  "userId": "wechat-user-id",
  "category": "news_alert",
  "dedupeKey": "news:2026-06-02:morning:wechat-user-id",
  "payload": {
    "content": "today's news summary"
  }
}
```

This preserves one delivery policy for both async backend tasks and scheduled Hermes cron output:

- Hermes owns when to trigger
- router owns whether and how to deliver
- ClawBot owns the final WeChat send

## Hermes Configuration

Hermes-side configuration:

```yaml
hermes_router:
  enabled: true
  extra:
    host: 127.0.0.1
    port: 8790
    profile: finance
    category: finance_alert
    router_url: http://127.0.0.1:3000
```

Router-side configuration:

```yaml
backends:
  endpointByRef:
    hermes-news: http://127.0.0.1:8788/hermes-router/message
    hermes-life: http://127.0.0.1:8789/hermes-router/message
    hermes-finance: http://127.0.0.1:8790/hermes-router/message
```

The platform:

- authenticate router requests with a bearer token
- exposes stable `/hermes-router/message` ingress per profile gateway
- create native Hermes gateway `MessageEvent` objects with `platform=hermes_router`
- preserve original source metadata such as `sourceChannel=wechat` and `externalUserId=wechat:<openid>`
- return the router backend response shape quickly, normally with `taskRef` and `taskStatus` for async work
- support async task completion by calling router `/internal/tasks/action` and `/internal/push`, not by sending directly to WeChat

This removes the per-profile-port workaround and makes `hermes-router` a real Hermes channel.

## Current Limitations

- Direct inbound reply flow still depends on the ClawBot receive bridge or webhook forwarder; the Fastify app itself does not yet host the long-poll receive loop.
- `/internal/push` can send through ClawBot in `wechat.mode=clawbot`, but broader multi-recipient fanout and routerUser-level targeting are not implemented yet.
- Backend task stop currently relies on the generic backend adapter and needs a stronger endpoint convention.
- Topic summaries are stored/cleared but not generated by an LLM summarizer.
