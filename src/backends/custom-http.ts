import type { BackendAdapter } from "./base.js";
import type { BackendRequest, BackendResponse } from "../domain/types.js";

export class CustomHttpBackendAdapter implements BackendAdapter {
  readonly kind: string = "custom-http";

  constructor(protected readonly endpointByRef: Record<string, string>) {}

  async send(request: BackendRequest): Promise<BackendResponse> {
    const endpoint = this.endpointByRef[request.agent.backendRef];
    if (!endpoint) {
      throw new Error(`missing endpoint for backendRef "${request.agent.backendRef}"`);
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: request.agent.agentId,
        message: request.message,
        inputType: request.inputType ?? "text",
        media: request.media,
        conversationId: request.conversation.conversationId,
        activeAgentId: request.conversation.activeAgentId,
        topicSummary: request.conversation.topicSummary,
        scenarioLabel: request.routeDecision.scenarioLabel,
        confirmationRef: request.confirmationRef,
        confirmed: request.confirmed
      })
    });
    if (!response.ok) {
      throw new Error(`backend HTTP ${response.status}`);
    }

    const body = await response.json() as {
      content?: string;
      taskRef?: string;
      taskStatus?: BackendResponse["taskStatus"];
      requiresConfirmation?: boolean;
      confirmationText?: string;
      confirmationRef?: string;
    };
    return {
      content: body.content ?? "",
      taskRef: body.taskRef,
      taskStatus: body.taskStatus,
      requiresConfirmation: body.requiresConfirmation,
      confirmationText: body.confirmationText,
      confirmationRef: body.confirmationRef,
      raw: body
    };
  }

  async stopTask(backendTaskRef: string): Promise<boolean> {
    const endpoint = this.endpointByRef[backendTaskRef] ?? `${backendTaskRef}/stop`;
    const response = await fetch(endpoint, { method: "POST" });
    return response.ok;
  }
}
