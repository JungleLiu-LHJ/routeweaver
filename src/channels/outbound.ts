import type { RouterConfig } from "../config/schema.js";
import { ClawBotClient } from "./clawbot/client.js";

export interface OutboundTextSender {
  sendText(userId: string, content: string): Promise<void>;
}

class NoopOutboundTextSender implements OutboundTextSender {
  async sendText(): Promise<void> {}
}

class ClawBotOutboundTextSender implements OutboundTextSender {
  private readonly client: ClawBotClient;

  constructor(config: RouterConfig) {
    const clawbot = config.wechat.clawbot;
    this.client = new ClawBotClient({
      sessionPath: clawbot.sessionPath,
      botType: clawbot.botType,
      botAgent: clawbot.botAgent,
      loginTimeoutMs: clawbot.loginTimeoutMs,
      longPollTimeoutMs: clawbot.longPollTimeoutMs,
      pollIntervalMs: clawbot.pollIntervalMs
    });
  }

  async sendText(userId: string, content: string): Promise<void> {
    await this.client.sendTextChunks({
      toUserId: userId,
      text: content
    });
  }
}

export function createOutboundTextSender(config: RouterConfig): OutboundTextSender {
  if (config.wechat.mode === "clawbot" && config.wechat.clawbot.enabled) {
    return new ClawBotOutboundTextSender(config);
  }
  return new NoopOutboundTextSender();
}
