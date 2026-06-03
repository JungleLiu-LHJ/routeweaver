import type { AgentProfile, ConversationState, RouteCorrectionHint, RouteDecision, RouterClassifierResponse } from "../domain/types.js";

export interface CandidateScore {
  agentId: string;
  continuityScore: number;
  keywordScore: number;
  scenarioScore: number;
  descriptionScore: number;
  correctionPenalty: number;
  ruleScore: number;
  classifierScore: number;
  compositeScore: number;
}

export interface RouterThresholds {
  minConfidenceDirect: number;
  minConfidenceKeepActive: number;
  minMarginDirect: number;
  clarifyBelow: number;
}

function normalize(text: string): string {
  return text.toLowerCase();
}

function containsHint(message: string, hints: string[]): number {
  const haystack = normalize(message);
  const matches = hints.filter((hint) => haystack.includes(hint.toLowerCase())).length;
  return hints.length === 0 ? 0 : Math.min(matches / hints.length, 1);
}

function descriptionMatch(message: string, agent: AgentProfile): number {
  const haystack = normalize(message);
  const fields = [
    agent.description,
    ...agent.capabilityTags,
    ...(agent.scenarioHints ?? [])
  ].join(" ");
  const terms = normalize(fields)
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .filter((term) => term.length >= 2);
  if (terms.length === 0) {
    return 0;
  }
  const matches = new Set(terms.filter((term) => haystack.includes(term)));
  return Math.min(matches.size / Math.min(terms.length, 8), 1);
}

function recentContinuityBoost(message: string, state: ConversationState, agent: AgentProfile): number {
  if (state.activeAgentId !== agent.agentId) {
    return 0;
  }

  const latestAgentTurn = [...state.recentTurns].reverse().find((turn) => turn.agentId === agent.agentId);
  if (!latestAgentTurn) {
    return 0.4;
  }

  const replySignal = /这个|继续|然后|顺便|另外|why|怎么|再看看/i.test(message);
  return replySignal ? 0.95 : 0.65;
}

function correctionPenalty(agent: AgentProfile, hints: RouteCorrectionHint[]): number {
  const recentMismatches = hints.filter((hint) => hint.predictedAgentId === agent.agentId).length;
  return Math.min(recentMismatches * 0.08, 0.24);
}

export function computeCandidateScores(
  message: string,
  state: ConversationState,
  agents: AgentProfile[],
  classifier: RouterClassifierResponse | null,
  corrections: RouteCorrectionHint[]
): CandidateScore[] {
  const classifierAlternatives = new Map(
    classifier?.alternatives.map((item) => [item.agentId, item.score]) ?? []
  );

  return agents.map((agent) => {
    const continuityScore = recentContinuityBoost(message, state, agent);
    const keywordScore = containsHint(message, agent.keywordHints);
    const scenarioScore = containsHint(message, agent.scenarioHints ?? []);
    const descriptionScore = descriptionMatch(message, agent);
    const penalty = correctionPenalty(agent, corrections);
    const ruleScore = Math.min(Math.max(
      continuityScore * 0.45 + keywordScore * 0.35 + scenarioScore * 0.3 + descriptionScore * 0.85 - penalty,
      0
    ), 1);
    const classifierScore =
      classifier?.topAgentId === agent.agentId
        ? classifier.confidence
        : classifierAlternatives.get(agent.agentId) ?? 0;
    const compositeScore = Math.max(classifier ? ruleScore * 0.55 + classifierScore * 0.45 : ruleScore, 0);

    return {
      agentId: agent.agentId,
      continuityScore,
      keywordScore,
      scenarioScore,
      descriptionScore,
      correctionPenalty: penalty,
      ruleScore,
      classifierScore,
      compositeScore
    };
  }).sort((left, right) => right.compositeScore - left.compositeScore);
}

export function mergeDecision(
  scores: CandidateScore[],
  state: ConversationState,
  classifier: RouterClassifierResponse | null,
  mainAgentId: string,
  thresholds: RouterThresholds
): RouteDecision {
  const [top, runnerUp] = scores;
  if (!top) {
    return {
      targetAgentId: mainAgentId,
      reason: "fallback_main",
      confidence: 0,
      shouldSwitchActiveAgent: state.activeAgentId !== mainAgentId
    };
  }

  const margin = Math.max(top.compositeScore - (runnerUp?.compositeScore ?? 0), classifier?.margin ?? 0);
  const isSwitch = Boolean(state.activeAgentId && state.activeAgentId !== top.agentId);
  const strongContinuity = top.agentId === state.activeAgentId && top.continuityScore >= 0.85;
  const strongClassifierTop =
    classifier?.topAgentId === top.agentId &&
    classifier.confidence >= thresholds.minConfidenceDirect &&
    (classifier.margin ?? margin) >= thresholds.minMarginDirect;

  if (classifier?.shouldClarify) {
    return {
      targetAgentId: state.activeAgentId ?? mainAgentId,
      reason: "clarify",
      confidence: top.compositeScore,
      margin,
      shouldSwitchActiveAgent: false,
      scenarioLabel: classifier?.scenarioLabel
    };
  }

  if (strongClassifierTop) {
    return {
      targetAgentId: top.agentId,
      reason: "llm_classifier",
      confidence: Math.max(top.compositeScore, classifier?.confidence ?? top.compositeScore),
      margin,
      shouldSwitchActiveAgent: top.agentId !== state.activeAgentId,
      scenarioLabel: classifier?.scenarioLabel
    };
  }

  if (top.compositeScore < thresholds.clarifyBelow) {
    return {
      targetAgentId: state.activeAgentId ?? mainAgentId,
      reason: "clarify",
      confidence: top.compositeScore,
      margin,
      shouldSwitchActiveAgent: false,
      scenarioLabel: classifier?.scenarioLabel
    };
  }

  if (strongContinuity && top.compositeScore >= thresholds.clarifyBelow) {
    return {
      targetAgentId: top.agentId,
      reason: "active_followup",
      confidence: top.compositeScore,
      margin,
      shouldSwitchActiveAgent: false,
      scenarioLabel: classifier?.scenarioLabel
    };
  }

  if (!isSwitch && top.compositeScore >= thresholds.minConfidenceKeepActive) {
    return {
      targetAgentId: top.agentId,
      reason: strongContinuity ? "active_followup" : classifier?.topAgentId === top.agentId ? "llm_classifier" : "keyword_rule",
      confidence: top.compositeScore,
      margin,
      shouldSwitchActiveAgent: false,
      scenarioLabel: classifier?.scenarioLabel
    };
  }

  if (isSwitch) {
    const activeScore = scores.find((score) => score.agentId === state.activeAgentId)?.compositeScore ?? 0;
    if (top.compositeScore >= thresholds.minConfidenceDirect && margin >= thresholds.minMarginDirect && top.compositeScore > activeScore) {
      return {
        targetAgentId: top.agentId,
        reason: classifier?.topAgentId === top.agentId ? "llm_classifier" : "keyword_rule",
        confidence: top.compositeScore,
        margin,
        shouldSwitchActiveAgent: true,
        scenarioLabel: classifier?.scenarioLabel
      };
    }

    return {
      targetAgentId: state.activeAgentId ?? mainAgentId,
      reason: "active_followup",
      confidence: activeScore,
      margin,
      shouldSwitchActiveAgent: false,
      scenarioLabel: classifier?.scenarioLabel
    };
  }

  if (top.compositeScore >= thresholds.minConfidenceDirect) {
    return {
      targetAgentId: top.agentId,
      reason: classifier?.topAgentId === top.agentId ? "llm_classifier" : "keyword_rule",
      confidence: top.compositeScore,
      margin,
      shouldSwitchActiveAgent: top.agentId !== state.activeAgentId,
      scenarioLabel: classifier?.scenarioLabel
    };
  }

  return {
    targetAgentId: mainAgentId,
    reason: "fallback_main",
    confidence: top.compositeScore,
    margin,
    shouldSwitchActiveAgent: mainAgentId !== state.activeAgentId,
    scenarioLabel: classifier?.scenarioLabel
  };
}
