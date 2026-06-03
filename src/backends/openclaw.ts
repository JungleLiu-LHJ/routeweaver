import { CustomHttpBackendAdapter } from "./custom-http.js";

export class OpenClawBackendAdapter extends CustomHttpBackendAdapter {
  readonly kind = "openclaw";
}
