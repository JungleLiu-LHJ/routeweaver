import type { BackendResponse, InboundMessage } from "../../domain/types.js";
import type { ChannelAdapter } from "../base.js";

interface WeChatWebhookPayload {
  FromUserName?: string;
  MsgId?: string | number;
  MsgType?: string;
  Content?: string;
  CreateTime?: string | number;
  Event?: string;
  EventKey?: string;
  PicUrl?: string;
  MediaId?: string;
  Format?: string;
  Recognition?: string;
}

function normalizeWechatText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export class WeChatChannelAdapter implements ChannelAdapter {
  readonly channelId = "wechat";
  readonly sentMessages: Array<{ userId: string; content: string }> = [];

  async parseInbound(payload: unknown): Promise<InboundMessage> {
    const data = payload as WeChatWebhookPayload;
    if (!data?.FromUserName) {
      throw new Error("invalid WeChat payload");
    }

    const event = data.Event?.toLowerCase();
    const eventKey = data.EventKey?.replace(/^qrscene_/, "");
    if ((event === "scan" || event === "subscribe") && eventKey) {
      const messageId = data.MsgId ?? `${event}:${data.FromUserName}:${eventKey}:${data.CreateTime ?? Date.now()}`;
      return {
        channelId: "wechat",
        userId: data.FromUserName,
        text: `/bind ${eventKey}`,
        externalMessageId: String(messageId),
        conversationId: `wechat:${data.FromUserName}`
      };
    }

    if (!data.MsgId) {
      throw new Error("invalid WeChat payload");
    }

    const msgType = data.MsgType?.toLowerCase();
    const recognitionText = normalizeWechatText(data.Recognition);
    if (msgType === "image") {
      return {
        channelId: "wechat",
        userId: data.FromUserName,
        text: "[image]",
        externalMessageId: String(data.MsgId),
        conversationId: `wechat:${data.FromUserName}`,
        inputType: "image",
        media: {
          mediaId: normalizeWechatText(data.MediaId),
          url: normalizeWechatText(data.PicUrl)
        }
      };
    }

    if (msgType === "voice") {
      return {
        channelId: "wechat",
        userId: data.FromUserName,
        text: recognitionText ?? "[voice]",
        externalMessageId: String(data.MsgId),
        conversationId: `wechat:${data.FromUserName}`,
        inputType: "voice",
        media: {
          mediaId: normalizeWechatText(data.MediaId),
          format: normalizeWechatText(data.Format),
          recognitionText
        }
      };
    }

    const content = normalizeWechatText(data.Content);
    if (!content) {
      throw new Error("invalid WeChat payload");
    }

    return {
      channelId: "wechat",
      userId: data.FromUserName,
      text: content,
      externalMessageId: String(data.MsgId),
      conversationId: `wechat:${data.FromUserName}`,
      inputType: "text"
    };
  }

  async formatOutbound(response: BackendResponse): Promise<unknown> {
    return {
      msgType: "text",
      content: response.content
    };
  }

  async sendOutbound(userId: string, response: BackendResponse): Promise<void> {
    this.sentMessages.push({ userId, content: response.content });
  }
}
