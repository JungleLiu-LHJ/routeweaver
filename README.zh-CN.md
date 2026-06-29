# RouteWeaver

一个入口，连接所有 agent。

`RouteWeaver` 是一个开源 agent router。它把 Hermes、OpenClaw、ACP coding agent 和通用 HTTP agent 放到同一个入口后面：用户可以正常聊天，也可以用 `/code`、`/ops` 这类显式命令指定 agent，还可以让 router 根据上下文自动分流。

[English README](./README.md)

## 为什么需要它

真实的 agent 系统很快会变复杂：

- Hermes 负责日常助手、提醒、异步任务。
- OpenClaw 负责工作流、连接器和桌面自动化。
- ACP coding agent 负责代码实现、debug、review。
- cron job 和后台 agent 还需要把结果推回用户。

`RouteWeaver` 做的事情很直接：给这些 agent 一个统一入口、统一路由状态和一个小型运维控制面。

## 核心能力

- 配置驱动的多 agent 路由：别名、关键词、sticky follow-up、可选 LLM classifier。
- 一等支持 Hermes、OpenClaw、ACP 和通用 HTTP backend。
- 支持 WeChat / ClawBot 入口，并能把图片、语音 metadata 转发给 Hermes backend。
- 支持 cron、告警、异步任务和 agent callback 通过 `/internal/push` 推送回用户。
- SQLite 存储绑定、会话、路由决策、任务引用、去重和审计记录。
- agent health check、restart command、restart cooldown 和 admin health snapshot。
- 推荐直接在每个 agent 上写 `backendUrl`，也兼容旧的 `backendRef` 映射写法。

## 快速开始

要求：

- Node.js 22+
- 至少一个能访问到的 agent backend

```bash
npm install
cp .env.example .env
npm run check
npm run dev
```

默认配置文件是 [`config/router.yaml`](./config/router.yaml)。示例里已经包含三类 agent：

- `assistant`: Hermes 主助手
- `coder`: ACP coding agent
- `ops`: OpenClaw 自动化 agent

## 最小 agent 配置

推荐每个 agent 直接声明自己的地址：

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

如果你更喜欢集中声明 backend，也可以继续用旧写法：

```yaml
backends:
  endpointByRef:
    hermes-main: http://127.0.0.1:8788/hermes-router/message

agents:
  - agentId: assistant
    backendKind: hermes
    backendRef: hermes-main
```

## 路由方式

RouteWeaver 会组合确定性路由和语义路由：

- 显式别名：`/code`、`/ops`、`/assistant`
- Sticky follow-up：一次会话路由到某个 agent 后，普通追问会在窗口期内继续发给它
- 关键词和能力标签
- 可选 LLM classifier，根据 confidence 和 margin 判断是否切换
- 置信度不足时回到 main agent

## 运维接口

查看 agent：

```bash
curl http://127.0.0.1:3000/admin/agents
```

查看心跳状态：

```bash
curl http://127.0.0.1:3000/admin/agents/health
```

通过 RouteWeaver 重启 agent：

```bash
curl -X POST http://127.0.0.1:3000/admin/agents/assistant/restart \
  -H "authorization: Bearer change-this-internal-push-token"
```

重启可以走 HTTP `restartUrl`，也可以走本地 `healthCheck.restartCommand`。后者适合本机部署 Hermes profile、OpenClaw 或其他长期运行的 agent。

## 常用端点

- `GET /healthz`
- `GET /readyz`
- `GET /admin/agents`
- `GET /admin/agents/health`
- `POST /admin/agents/:agentId/restart`
- `POST /webhooks/wechat`
- `POST /webhooks/clawbot`
- `POST /internal/push`
- `POST /internal/tasks/action`

## 目录结构

```text
src/
  backends/       Hermes、OpenClaw、ACP 和 HTTP backend adapter
  channels/       WeChat、ClawBot 和 outbound delivery
  classifier/     LLM classifier prompt、parser、provider
  config/         YAML 加载和校验
  domain/         router 核心类型和命令
  observability/  审计和日志
  push/           内部 push 投递
  router/         路由策略和编排
  server/         Fastify app、admin API、agent monitor
  store/          SQLite repository 和 schema
  tasks/          异步任务引用
test/             配置、路由、webhook、backend、monitor 测试
docs/             技术文档
```

## 文档

- English: [README.md](./README.md)
- 技术设计: [docs/hermes-router-technical-design.md](./docs/hermes-router-technical-design.md)
- ClawBot 使用: [docs/clawbot-usage.zh-CN.md](./docs/clawbot-usage.zh-CN.md)
- Hermes cron 通过 router 推送: [docs/hermes-cron-via-router.zh-CN.md](./docs/hermes-cron-via-router.zh-CN.md)

## 开源协议

MIT，见 [LICENSE](./LICENSE)。
