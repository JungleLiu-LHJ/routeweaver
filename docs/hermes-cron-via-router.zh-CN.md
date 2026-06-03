# Hermes Cron 通过 Router 发微信

目标链路：

```text
Hermes cron job -> deliver=hermes_router -> hermes-router /internal/push -> ClawBot -> 微信
```

这里的边界要固定：

- `cron` 继续由各个 Hermes profile 自己执行
- `hermes-router` 负责用户绑定、分类校验、去重、静音、审计、最终发微信
- Hermes 不直接发微信；它通过原生 `hermes_router` platform adapter 回到 router

## 什么时候调用

当某个 Hermes profile 的 cron 产出一条要主动推送给微信用户的消息时，cron job 使用：

```text
deliver=hermes_router
```

`hermes_router` adapter 的 standalone sender 会调用 router：

```text
POST /internal/push
```

底层鉴权方式：

```text
Authorization: Bearer <security.internalPushToken>
```

## 请求格式

```json
{
  "userId": "微信用户id",
  "category": "news_alert",
  "dedupeKey": "news:2026-06-02:morning:o9cq...",
  "priority": "normal",
  "payload": {
    "content": "今天的新闻摘要..."
  }
}
```

字段说明：

- `userId`: 微信侧用户 id，必须已经在 router 里绑定
- `category`: push 类别，必须出现在对应 agent 的 `pushCategories`
- `dedupeKey`: 可选，建议 cron 场景总是带上，避免重复推送
- `payload.content`: 最终发送给微信的文本

## 不同 Hermes profile 怎么区分

建议直接按 profile 约定不同 `category`：

- `news` -> `news_alert`
- `life` -> `life_alert`
- `finance` -> `finance_alert`

这样 router 不需要知道“是哪一个 cron 代码发来的”，只需要校验：

1. 这个 category 是否已在配置里声明
2. 这个微信用户是否绑定
3. 这个 category 是否被用户 mute

## Router 配置

`config/router.yaml` 里每个 agent 已经有自己的 `pushCategories`，例如：

```yaml
agents:
  - agentId: news
    pushCategories: [news_alert]

  - agentId: life
    pushCategories: [life_alert, travel_alert]

  - agentId: finance
    pushCategories: [finance_alert]
```

`security.internalPushToken` 要和 Hermes 侧调用时带的 Bearer token 一致。

如果当前使用的是：

```yaml
wechat:
  mode: clawbot
  clawbot:
    enabled: true
    sessionPath: .data/clawbot-session.json
```

那么 `/internal/push` 会直接复用本地 ClawBot session 发微信，不需要额外桥接进程回发。

## Hermes 配置

Hermes 侧启用原生 platform adapter：

```yaml
hermes_router:
  enabled: true
  extra:
    host: 127.0.0.1
    port: 8788
    profile: news
    category: news_alert
    router_url: http://127.0.0.1:3000
```

需要的环境变量：

```text
HERMES_ROUTER_ADAPTER_TOKEN=change-me
HERMES_ROUTER_URL=http://127.0.0.1:3000
HERMES_ROUTER_TOKEN=change-this-internal-push-token
HERMES_ROUTER_HOME_CHANNEL=<微信用户id>
```

## 最小调用示例

```bash
curl -X POST http://127.0.0.1:3000/internal/push \
  -H 'authorization: Bearer change-this-internal-push-token' \
  -H 'content-type: application/json' \
  -d '{
    "userId": "wechat-user-id",
    "category": "news_alert",
    "dedupeKey": "news:2026-06-02:morning:wechat-user-id",
    "payload": {
      "content": "今日早报：1. ... 2. ... 3. ..."
    }
  }'
```

## Hermes 侧建议实现

Hermes 不需要感知微信协议，只要让 cron job 走 `deliver=hermes_router`：

```text
profile cron -> render text -> deliver=hermes_router
```

建议每个 profile 配不同 category：

- `news` sender 固定发 `news_alert`
- `life` sender 固定发 `life_alert`
- `finance` sender 固定发 `finance_alert`

这样 profile 内部代码不用重复处理 token、URL、category 拼装。

## 当前限制

- `HERMES_ROUTER_HOME_CHANNEL` 目前需要明确指向要推送的微信用户
- 还没有做“按 routerUserId 查所有已绑定微信账号再群发”的 fanout 能力
