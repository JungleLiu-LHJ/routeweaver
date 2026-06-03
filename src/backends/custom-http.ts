import type { BackendAdapter } from "./base.js";
import type { AgentProfile, BackendRequest, BackendResponse } from "../domain/types.js";

export class CustomHttpBackendAdapter implements BackendAdapter {
  readonly kind: string = "custom-http";

  constructor(protected readonly endpointByRef: Record<string, string>) {}

  async send(request: BackendRequest): Promise<BackendResponse> {
    const endpoint = this.endpointForAgent(request.agent);

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

  async restartAgent(agent: AgentProfile): Promise<boolean> {
    const endpoint = this.controlUrlForAgent(agent, "restart");
    if (!endpoint) {
      return false;
    }
    const response = await fetch(endpoint, { method: "POST" });
    return response.ok;
  }

  async checkHealth(agent: AgentProfile): Promise<{ ok: boolean; status?: number }> {
    const endpoint = this.controlUrlForAgent(agent, "health");
    if (!endpoint) {
      return { ok: false };
    }
    const response = await fetch(endpoint, { method: "GET" });
    return { ok: response.ok, status: response.status };
  }

  async stopTask(backendTaskRef: string): Promise<boolean> {
    const endpoint = this.endpointByRef[backendTaskRef] ?? `${backendTaskRef}/stop`;
    const response = await fetch(endpoint, { method: "POST" });
    return response.ok;
  }

  protected endpointForAgent(agent: AgentProfile): string {
    if (agent.backendUrl) {
      return agent.backendUrl;
    }
    if (agent.backendRef) {
      const endpoint = this.endpointByRef[agent.backendRef];
      if (endpoint) {
        return endpoint;
      }
      throw new Error(`missing endpoint for backendRef "${agent.backendRef}"`);
    }
    throw new Error(`agent "${agent.agentId}" must define backendUrl or backendRef`);
  }

  private controlUrlForAgent(agent: AgentProfile, kind: "restart" | "health"): string | undefined {
    if (kind === "restart" && agent.restartUrl) {
      return agent.restartUrl;
    }
    if (kind === "health" && agent.healthUrl) {
      return agent.healthUrl;
    }

    const base = agent.backendUrl ?? (agent.backendRef ? this.endpointByRef[agent.backendRef] : undefined);
    if (!base) {
      return undefined;
    }

    if (base.endsWith("/message")) {
      return `${base.slice(0, -"/message".length)}/${kind}`;
    }
    return `${base.replace(/\/$/, "")}/${kind}`;
  }
}
