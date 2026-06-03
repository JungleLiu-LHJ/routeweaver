import type { RouterClassifierProvider } from "./base.js";
import type { RouterClassifierRequest, RouterClassifierResponse } from "../domain/types.js";
import { buildClassifierPrompt } from "./prompt.js";
import { parseClassifierResponse } from "./parser.js";

export class NullClassifierProvider implements RouterClassifierProvider {
  async classify(): Promise<RouterClassifierResponse> {
    return {
      topAgentId: null,
      confidence: 0,
      reasoningTags: ["classifier_disabled"],
      alternatives: []
    };
  }
}

export class OpenAICompatibleClassifierProvider implements RouterClassifierProvider {
  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey: string;
      model: string;
      timeoutMs: number;
    }
  ) {}

  async classify(input: RouterClassifierRequest): Promise<RouterClassifierResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

    try {
      const response = await fetch(`${this.options.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`
        },
        body: JSON.stringify({
          model: this.options.model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "You are a routing classifier. Return JSON only." },
            { role: "user", content: buildClassifierPrompt(input) }
          ]
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`classifier HTTP ${response.status}`);
      }

      const json = await response.json() as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      const content = json.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error("classifier response was empty");
      }
      return parseClassifierResponse(content, input.candidateAgents);
    } finally {
      clearTimeout(timer);
    }
  }
}
