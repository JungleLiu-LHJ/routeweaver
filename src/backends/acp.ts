import { CustomHttpBackendAdapter } from "./custom-http.js";

export class AcpBackendAdapter extends CustomHttpBackendAdapter {
  readonly kind = "acp";
}
