# hermes-router

`hermes-router` is a standalone TypeScript service for:

- receiving channel messages
- routing them to the right agent or Hermes profile
- dispatching to Hermes, ACP, OpenClaw, or custom HTTP backends
- handling binding, push delivery, tasks, and audit records

This repo is structured to be published as a public example of an agent-routing gateway.

## Highlights

- Config-driven agent registry in [`config/router.yaml`](./config/router.yaml)
- Rule-based plus LLM-assisted routing
- Fastify HTTP server with public, admin, and internal endpoints
- SQLite persistence for bindings, tasks, conversation state, and audit events
- WeChat / ClawBot oriented ingress and outbound delivery flow
- Backend abstraction for Hermes, ACP, OpenClaw, and generic HTTP agents

## Project Layout

```text
src/
  backends/       backend adapters
  channels/       inbound/outbound channel integrations
  classifier/     LLM classifier contract, prompt, parser, providers
  config/         config loader and schema
  domain/         core types and commands
  observability/  logging and audit hooks
  push/           internal push delivery
  router/         routing policy and orchestration
  server/         Fastify app and bootstrap
  store/          SQLite repository and schema
  tasks/          async task state handling
test/             vitest coverage for router and backend behavior
docs/             technical notes and usage docs
```

## Quick Start

```bash
npm install
cp .env.example .env
npm run check
npm run dev
```

Default config path is [`config/router.yaml`](./config/router.yaml).

## Configuration

The sample config ships with three example Hermes backends:

```yaml
backends:
  endpointByRef:
    hermes-news: http://127.0.0.1:8788/hermes-router/message
    hermes-life: http://127.0.0.1:8789/hermes-router/message
    hermes-finance: http://127.0.0.1:8790/hermes-router/message
```

Before using this in any real environment, change:

- `security.internalPushToken`
- backend URLs
- classifier model / API settings
- WeChat / ClawBot session paths and operational settings

Classifier routing is enabled through environment variables such as `ROUTER_CLASSIFIER_API_KEY` and optionally `ROUTER_CLASSIFIER_BASE_URL`.

## Runtime Model

Typical message path:

```text
External channel -> hermes-router -> selected backend agent -> async task / push callback
```

The router submits backend work through `/hermes-router/message` style endpoints and expects long-running work to complete asynchronously through:

```text
POST /internal/tasks/action
POST /internal/push
```

## Webhook Example

```bash
curl -s -X POST "http://127.0.0.1:3000/webhooks/clawbot?token=$INTERNAL_PUSH_TOKEN" \
  -H "content-type: application/json" \
  -d '{"openid":"wechat-user-id","text":"/news today","messageId":"m1"}'
```

## Publish Notes

This exported copy intentionally excludes local state and build artifacts:

- `node_modules/`
- `dist/`
- `.data/`
- `.runtime/`
- `logs/`

If you want to publish this repo, initialize git inside this folder and add your GitHub remote.
