import { CustomHttpBackendAdapter } from "./custom-http.js";
import type { BackendRequest, BackendResponse } from "../domain/types.js";

const HERMES_SUBMIT_TIMEOUT_MS = 3_000;

export class HermesBackendAdapter extends CustomHttpBackendAdapter {
  readonly kind = "hermes";

  async send(request: BackendRequest): Promise<BackendResponse> {
    const endpoint = this.endpointFor(request.agent.backendRef);
    const adapterToken = process.env.HERMES_ROUTER_ADAPTER_TOKEN ?? process.env.ROUTER_HERMES_ADAPTER_TOKEN;
    const headers: Record<string, string> = {
      "content-type": "application/json"
    };
    if (adapterToken) {
      headers.authorization = `Bearer ${adapterToken}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HERMES_SUBMIT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          responseMode: "async",
          profile: request.agent.agentId,
          agentId: request.agent.agentId,
          message: request.message,
          inputType: request.inputType ?? "text",
          media: request.media,
          conversationId: request.conversation.conversationId,
          userId: request.conversation.userId,
          sourceChannel: request.conversation.channelId,
          activeAgentId: request.conversation.activeAgentId,
          topicSummary: request.conversation.topicSummary,
          scenarioLabel: request.routeDecision.scenarioLabel,
          confirmationRef: request.confirmationRef,
          confirmed: request.confirmed,
          messageId: `${request.conversation.conversationId}:${Date.now()}`
        })
      });
      if (!response.ok) {
        throw new Error(`hermes HTTP ${response.status}`);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`hermes submit timeout after ${HERMES_SUBMIT_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    const body = await response.json() as {
      content?: string;
      taskRef?: string;
      taskStatus?: BackendResponse["taskStatus"];
      requiresConfirmation?: boolean;
      confirmationText?: string | null;
      confirmationRef?: string | null;
    };
    return {
      content: body.content ?? "",
      taskRef: body.taskRef,
      taskStatus: body.taskStatus,
      requiresConfirmation: body.requiresConfirmation,
      confirmationText: body.confirmationText ?? undefined,
      confirmationRef: body.confirmationRef ?? undefined,
      raw: body
    };
  }

  private endpointFor(backendRef: string): string {
    const endpoint = this.endpointByRef[backendRef];
    if (!endpoint) {
      throw new Error(`missing endpoint for backendRef "${backendRef}"`);
    }
    return endpoint;
  }
}
