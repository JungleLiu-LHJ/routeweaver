import { createInterface } from "node:readline/promises";
import process from "node:process";
import { loadRouterConfig } from "../../config/index.js";
import { ClawBotClient } from "./client.js";

function startTypingHeartbeat(client: ClawBotClient, toUserId: string, contextToken?: string) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    if (stopped) {
      return;
    }
    try {
      await client.sendTyping({ toUserId, contextToken, status: "start" });
    } catch {}
    if (!stopped) {
      timer = setTimeout(() => {
        void tick();
      }, 4_000);
    }
  };

  void tick();

  return {
    async stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      try {
        await client.sendTyping({ toUserId, contextToken, status: "stop" });
      } catch {}
    }
  };
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function main() {
  const command = (process.env.CLAWBOT_COMMAND ?? "status").trim();
  const configPath = process.env.ROUTER_CONFIG_PATH ?? "config/router.yaml";
  const config = await loadRouterConfig(configPath);
  const clawbot = config.wechat.clawbot;
  const routerUrl = (process.env.CLAWBOT_ROUTER_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");

  const client = new ClawBotClient({
    sessionPath: clawbot.sessionPath,
    botType: clawbot.botType,
    botAgent: clawbot.botAgent,
    loginTimeoutMs: clawbot.loginTimeoutMs,
    longPollTimeoutMs: clawbot.longPollTimeoutMs,
    pollIntervalMs: clawbot.pollIntervalMs
  });

  switch (command) {
    case "login": {
      const started = await client.startLogin(true);
      process.stdout.write(`${started.message}\n`);
      await client.renderQrToTerminal(started.qrCodeUrl);
      process.stdout.write(`${started.qrCodeUrl}\n`);
      const result = await client.waitForLogin({
        sessionKey: started.sessionKey,
        timeoutMs: clawbot.loginTimeoutMs,
        onVerificationCode: async () => prompt("请输入微信上显示的数字验证码: ")
      });
      process.stdout.write(`${result.message}\n`);
      if (result.connected) {
        process.stdout.write(`accountId=${result.accountId ?? ""}\n`);
        process.stdout.write(`userId=${result.userId ?? ""}\n`);
      }
      return;
    }
    case "listen": {
      process.stdout.write("开始监听微信消息，按 Ctrl+C 退出。\n");
      await client.startReceiveLoop({
        onMessage: async (event) => {
          process.stdout.write(`[${event.fromUserId}] ${event.text}\n`);
        },
        onError: async (error) => {
          process.stderr.write(`listen error: ${String(error)}\n`);
        }
      });
      return;
    }
    case "route": {
      process.stdout.write(`开始监听并转发到 router: ${routerUrl}\n`);
      await client.startReceiveLoop({
        onMessage: async (event) => {
          process.stdout.write(`[${event.fromUserId}] ${event.text}\n`);
          const typing = startTypingHeartbeat(client, event.fromUserId, event.contextToken);
          try {
            const response = await fetch(`${routerUrl}/webhooks/clawbot`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${config.security.internalPushToken}`
              },
              body: JSON.stringify({
                openid: event.fromUserId,
                messageId: event.messageId,
                text: event.text
              })
            });
            if (!response.ok) {
              const body = await response.text();
              throw new Error(`router ${response.status}: ${body}`);
            }
            const payload = await response.json() as { content?: string; deduped?: boolean };
            if (payload.deduped || !payload.content?.trim()) {
              return;
            }
            const sent = await client.sendTextChunks({
              toUserId: event.fromUserId,
              text: payload.content
            });
            process.stdout.write(`sent ${sent.length} chunk(s) to ${event.fromUserId}\n`);
          } finally {
            await typing.stop();
          }
        },
        onError: async (error) => {
          process.stderr.write(`route error: ${String(error)}\n`);
        }
      });
      return;
    }
    case "send": {
      const toUserId = process.env.CLAWBOT_TO?.trim();
      const text = process.env.CLAWBOT_TEXT?.trim();
      if (!toUserId || !text) {
        throw new Error("CLAWBOT_TO and CLAWBOT_TEXT are required for send");
      }
      const result = await client.sendText({ toUserId, text });
      process.stdout.write(`sent: ${result.messageId}\n`);
      return;
    }
    case "logout": {
      await client.clearSession();
      process.stdout.write("已清理本地 session。\n");
      return;
    }
    case "status":
    default: {
      const session = await client.loadSession();
      if (!session) {
        process.stdout.write("未登录。\n");
        return;
      }
      process.stdout.write(`accountId=${session.accountId ?? ""}\n`);
      process.stdout.write(`userId=${session.userId ?? ""}\n`);
      process.stdout.write(`baseUrl=${session.baseUrl}\n`);
      process.stdout.write(`savedAt=${session.savedAt ?? ""}\n`);
    }
  }
}

void main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
