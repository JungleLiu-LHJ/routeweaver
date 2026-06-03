import type { BackendResponse, InboundMessage } from "../domain/types.js";

export interface ChannelAdapter {
  readonly channelId: string;
  parseInbound(payload: unknown): Promise<InboundMessage>;
  formatOutbound(response: BackendResponse): Promise<unknown>;
}
