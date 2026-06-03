import type { RouterClassifierRequest } from "../domain/types.js";

export function buildClassifierPrompt(input: RouterClassifierRequest): string {
  const candidates = input.candidateAgents.map((agent) => ({
    agentId: agent.agentId,
    description: agent.description,
    capabilityTags: agent.capabilityTags,
    scenarioHints: agent.scenarioHints ?? []
  }));

  return JSON.stringify({
    instruction: "Classify the message to one configured agent only. Return strict JSON.",
    activeAgentId: input.activeAgentId,
    topicSummary: input.topicSummary,
    recentTurns: input.recentTurns,
    message: input.message,
    candidates,
    outputSchema: {
      topAgentId: "string|null",
      confidence: "number",
      margin: "number",
      scenarioLabel: "string|undefined",
      reasoningTags: ["string"],
      alternatives: [{ agentId: "string", score: "number" }],
      shouldClarify: "boolean|undefined"
    }
  });
}
