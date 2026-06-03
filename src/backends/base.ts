import type { BackendRequest, BackendResponse } from "../domain/types.js";

export interface BackendAdapter {
  readonly kind: string;
  send(request: BackendRequest): Promise<BackendResponse>;
  stopTask?(backendTaskRef: string): Promise<boolean>;
}
