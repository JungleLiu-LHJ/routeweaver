import type { RouterClassifierRequest, RouterClassifierResponse } from "../domain/types.js";

export interface RouterClassifierProvider {
  classify(input: RouterClassifierRequest): Promise<RouterClassifierResponse>;
}
