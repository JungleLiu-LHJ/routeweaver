import type { AgentProfile, RouterClassifierResponse } from "../domain/types.js";

export function parseClassifierResponse(raw: string, candidateAgents: AgentProfile[]): RouterClassifierResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("classifier returned invalid JSON");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("classifier returned non-object payload");
  }

  const value = parsed as Partial<RouterClassifierResponse>;
  const knownIds = new Set(candidateAgents.map((agent) => agent.agentId));

  if (value.topAgentId && !knownIds.has(value.topAgentId)) {
    throw new Error(`classifier selected unknown agent "${value.topAgentId}"`);
  }

  for (const alternative of value.alternatives ?? []) {
    if (!knownIds.has(alternative.agentId)) {
      throw new Error(`classifier alternative "${alternative.agentId}" is not configured`);
    }
  }

  return {
    topAgentId: value.topAgentId ?? null,
    confidence: typeof value.confidence === "number" ? value.confidence : 0,
    margin: typeof value.margin === "number" ? value.margin : undefined,
    scenarioLabel: value.scenarioLabel,
    reasoningTags: Array.isArray(value.reasoningTags) ? value.reasoningTags : [],
    alternatives: Array.isArray(value.alternatives) ? value.alternatives : [],
    shouldClarify: value.shouldClarify === true
  };
}
