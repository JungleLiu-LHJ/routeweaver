import type { AgentProfile, BackendRequest, BackendResponse } from "../domain/types.js";

export interface BackendAdapter {
  readonly kind: string;
  send(request: BackendRequest): Promise<BackendResponse>;
  stopTask?(backendTaskRef: string): Promise<boolean>;
  restartAgent?(agent: AgentProfile): Promise<boolean>;
  checkHealth?(agent: AgentProfile): Promise<{ ok: boolean; status?: number }>;
}
