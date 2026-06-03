# RouteWeaver

`RouteWeaver` 是一个开源的 agent router，用来把外部消息统一路由到不同类型的 agent 后端。

它重点支持三类后端：

- `Hermes`
- `OpenClaw`
- `ACP` coding agent

你也可以继续接自己的通用 HTTP agent。

## 它解决什么问题

很多团队已经有多个 agent，但入口是分散的：

- 一个 Hermes 处理日常助手
- 一个 OpenClaw 处理自动化和连接器
- 一个 ACP agent 处理 coding / debug

`RouteWeaver` 把这些后端放到一个统一入口后面，负责：

- 接收渠道消息
- 按 agent 能力做路由
- 维护会话上下文和 active agent
- 管理绑定、push、任务状态和审计
- 通过管理接口检查或重启 agent

## 为什么它更方便

配置尽量做成“每个 agent 自己写自己的地址”，不需要先声明一层全局映射再回填：

```yaml
agents:
  - agentId: coder
    backendKind: acp
    backendUrl: http://127.0.0.1:8790/message
    restartUrl: http://127.0.0.1:8790/restart
    healthUrl: http://127.0.0.1:8790/health
```

如果你已经有老配置，也仍然支持 `backendRef + backends.endpointByRef` 的写法。

## 快速开始

要求：

- Node.js 22+
- 一个或多个可访问的 agent backend

安装：

```bash
npm install
cp .env.example .env
npm run check
npm run dev
```

默认配置文件是 [`config/router.yaml`](./config/router.yaml)。

## 默认示例里包含什么

仓库自带的示例配置已经覆盖三类 agent：

- `assistant`: `Hermes` 主助手
- `coder`: `ACP` coding agent
- `ops`: `OpenClaw` 自动化 agent

这样别人一看就知道这不是只给 Hermes 用的，而是一个通用的 agent routing layer。

## 最小配置示例

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

## 重启 agent

如果某个 agent 暴露了 `restartUrl`，可以直接通过 router 统一触发重启：

```bash
curl -X POST http://127.0.0.1:3000/admin/agents/coder/restart \
  -H "authorization: Bearer change-this-internal-push-token"
```

这对公开部署很重要，因为你不希望每个 agent 都有一套不同的运维入口。

## 常用接口

- `GET /healthz`
- `GET /readyz`
- `GET /admin/agents`
- `POST /admin/agents/:agentId/restart`
- `POST /webhooks/wechat`
- `POST /webhooks/clawbot`
- `POST /internal/push`
- `POST /internal/tasks/action`

## 路由方式

路由逻辑由三部分组成：

- 显式别名，如 `/code`、`/ops`
- 关键词和能力标签
- 可选的 LLM classifier

也就是说，用户既可以手动指定 agent，也可以让 router 自动分流。

## 适合公开开源的点

- 不绑定单一 agent runtime
- 对 Hermes / OpenClaw / ACP 都是一等支持
- 配置直观
- 管理入口统一
- 核心能力有测试覆盖

## 文档

- English: [README.md](./README.md)
- 技术设计: [docs/hermes-router-technical-design.md](./docs/hermes-router-technical-design.md)
- ClawBot 使用: [docs/clawbot-usage.zh-CN.md](./docs/clawbot-usage.zh-CN.md)

## 开源协议

本项目采用 `MIT` 协议，见 [LICENSE](./LICENSE)。
