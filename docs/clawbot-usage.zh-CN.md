# ClawBot 使用说明

这套接入现在已经有一个独立可运行的客户端：

- `src/channels/clawbot/client.ts`
- `src/channels/clawbot/demo.ts`

用途是直接连微信 ClawBot，完成：

- 扫码登录
- 本地保存 session
- 长轮询收消息
- 主动发消息

## 1. 配置

编辑 `config/router.yaml`，确认有这段：

```yaml
wechat:
  bindingTokenTtlSeconds: 600
  mode: clawbot
  clawbot:
    enabled: true
    sessionPath: .data/clawbot-session.json
    pollIntervalMs: 1000
    loginTimeoutMs: 480000
    longPollTimeoutMs: 35000
    botType: "3"
    botAgent: HermesRouter/0.1.0
```

字段说明：

- `sessionPath`: 本地微信登录态保存位置
- `pollIntervalMs`: 轮询失败后的重试间隔
- `loginTimeoutMs`: 扫码等待超时
- `longPollTimeoutMs`: 单次收消息长轮询超时
- `botType`: 先保持 `"3"`
- `botAgent`: 发给微信后台的标识，便于排查日志

## 2. 扫码登录

先安装依赖：

```bash
npm install
```

然后执行：

```bash
CLAWBOT_COMMAND=login npm run clawbot:demo
```

终端会打印二维码。用微信扫码，如果微信要求输入数字验证码，就按终端提示输入。

成功后会在 `sessionPath` 写入本地 session。

## 3. 查看登录状态

```bash
CLAWBOT_COMMAND=status npm run clawbot:demo
```

如果已经绑定，会看到：

- `accountId`
- `userId`
- `baseUrl`
- `savedAt`

## 4. 启动收消息

```bash
CLAWBOT_COMMAND=listen npm run clawbot:demo
```

效果是：

- 持续从微信收消息
- 终端打印 `[fromUserId] 文本内容`
- 自动保存 `context_token` 和 `get_updates_buf`

按 `Ctrl+C` 退出。

## 5. 启动路由转发

如果要把微信消息直接转给 `hermes-router`，执行：

```bash
CLAWBOT_COMMAND=route CLAWBOT_ROUTER_URL='http://127.0.0.1:3000' npm run clawbot:demo
```

效果是：

- 先监听微信消息
- 每条消息转发到 `/webhooks/clawbot`
- 如果 router 返回文本回复，再自动回发到微信

前提：

- `hermes-router` 服务已经启动
- `config/router.yaml` 里的 `security.internalPushToken` 和当前 router 一致
- 各个 Hermes backend 已经启动

## 6. 主动发消息

```bash
CLAWBOT_COMMAND=send CLAWBOT_TO='对方的微信 user id' CLAWBOT_TEXT='你好' npm run clawbot:demo
```

说明：

- `CLAWBOT_TO` 一般是你先收过一次这个人的消息后，从监听日志里拿到
- 如果之前已经收过这个人的消息，客户端会自动复用本地保存的 `context_token`

## 7. 清理本地 session

```bash
CLAWBOT_COMMAND=logout npm run clawbot:demo
```

## 8. 当前边界

现在这一版已经能独立完成 ClawBot 连接层，也可以通过 `route` 模式转发到现有 router，但还没有自动接进 Fastify 管理接口。

也就是说：

- 登录、监听、发消息、转发到 router 已经可用
- 还没有接成 `/admin/clawbot/login` 这类 HTTP 接口
- `route` 模式目前运行在独立 demo 进程里，不是 Fastify 内建生命周期的一部分

下一步接线时，直接把 `listen` 收到的事件转成 `InboundMessage` 再走 router 即可。
