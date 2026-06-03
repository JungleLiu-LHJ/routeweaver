import type { OutboundTextSender } from "../channels/outbound.js";
import type { SQLiteRouterRepository } from "../store/repositories.js";

export interface PushRequest {
  userId: string;
  category: string;
  payload: Record<string, unknown>;
  dedupeKey?: string;
  priority?: "low" | "normal" | "high";
}

export interface PushResult {
  accepted: boolean;
  reason?: string;
}

function normalizeWechatUserId(userId: string): string {
  const trimmed = userId.trim();
  return trimmed.startsWith("wechat:") ? trimmed.slice("wechat:".length) : trimmed;
}

export class PushService {
  constructor(
    private readonly repository: SQLiteRouterRepository,
    private readonly sender: OutboundTextSender,
    private readonly allowedCategories: Set<string>
  ) {}

  async accept(request: PushRequest): Promise<PushResult> {
    if (!request.userId || !request.category) {
      return { accepted: false, reason: "userId and category are required" };
    }
    const normalizedUserId = normalizeWechatUserId(request.userId);
    if (!this.allowedCategories.has(request.category)) {
      return { accepted: false, reason: "category is not configured" };
    }
    if (request.dedupeKey && await this.repository.isPushDuplicate(request.dedupeKey)) {
      return { accepted: false, reason: "duplicate" };
    }
    const binding = await this.repository.findBinding("wechat", normalizedUserId);
    if (!binding || binding.status !== "bound") {
      return { accepted: false, reason: "wechat user is not bound" };
    }
    if (await this.repository.getPushMuted(normalizedUserId, request.category)) {
      return { accepted: false, reason: "category is muted" };
    }

    const content = String(request.payload.content ?? request.payload.text ?? JSON.stringify(request.payload));
    await this.repository.recordPushEvent(normalizedUserId, request.category, request.payload);
    try {
      await this.sender.sendText(normalizedUserId, content);
      return { accepted: true };
    } catch (error) {
      await this.repository.writeAudit("push.delivery_failed", {
        userId: normalizedUserId,
        category: request.category,
        error: String(error)
      });
      return { accepted: false, reason: "channel delivery failed" };
    }
  }
}
