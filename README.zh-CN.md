# RouteWeaver

一个微信会话，连接多个 Hermes 专长助手。

RouteWeaver 是一个轻量 router，放在你的 Hermes profiles 前面。用户在微信里自然聊天，也可以用斜杠命令切到指定助手；后续追问会自动持续发给刚才那个 Hermes agent。

[English README](./README.md)

## 当前支持

- 微信入口
- Hermes backend
- 自然聊天、斜杠路由、sticky follow-up
- Hermes 异步结果回推
- 本地 Hermes profile 的 health check 和 restart

## 用户怎么交互

用户不需要关心端口和 profile。

- 直接发普通消息，默认进入主 Hermes
- 用 `/news`、`/life`、`/finance` 显式切换
- 后续自然追问会在一段时间内保持路由到当前 agent
- Hermes 的长任务做完后，可以通过 router 异步回推结果

例子：

- `明天去上海，帮我排个行程`
- `/news summarize today's AI news`
- `/finance 帮我看下这个月支出`

## 快速开始

要求：

- Node.js 22+
- 本地已经有可访问的 Hermes profiles

```bash
npm install
cp .env.example .env
npm run check
npm run dev
```

RouteWeaver 读取 [`config/router.yaml`](./config/router.yaml)。

## 默认交互模型

示例配置里有三个 Hermes agent：

- `news`：新闻、公开信息、briefing
- `life`：日常规划、出行、生活事务
- `finance`：预算、账单、支出、投资跟踪

默认主 agent 是 `life`。

## 最小配置形态

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

## 运维接口

```bash
curl http://127.0.0.1:3000/admin/agents
curl http://127.0.0.1:3000/admin/agents/health
curl -X POST http://127.0.0.1:3000/admin/agents/life/restart \
  -H "authorization: Bearer change-this-internal-push-token"
```

常用端点：

- `GET /healthz`
- `GET /readyz`
- `GET /admin/agents`
- `GET /admin/agents/health`
- `POST /admin/agents/:agentId/restart`
- `POST /webhooks/wechat`
- `POST /internal/push`
- `POST /internal/tasks/action`

## 为什么这样收口

这个公开版刻意保持聚焦：

- 只讲一个入口：微信
- 只讲一类 backend：Hermes
- 只解决一件事：把用户稳定路由到对的助手

这样更容易上手，也更容易真正跑起来。

## 开源协议

MIT，见 [LICENSE](./LICENSE)。
