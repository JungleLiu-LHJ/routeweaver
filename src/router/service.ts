import { parseCommand } from "../domain/commands.js";
import type { AgentProfile, ConversationState, InboundMessage, RouteCorrectionHint, RouteDecision } from "../domain/types.js";
import type { RouterConfig } from "../config/schema.js";
import type { RouterClassifierProvider } from "../classifier/base.js";
import { computeCandidateScores, mergeDecision } from "./policy.js";

export interface RouterServiceDependencies {
  config: RouterConfig;
  classifier: RouterClassifierProvider;
  loadConversationState(message: InboundMessage): Promise<ConversationState>;
  listCorrections(conversationId: string): Promise<RouteCorrectionHint[]>;
  recordClassifierFailure?(error: unknown): Promise<void>;
}

export interface RoutedMessage {
  decision: RouteDecision;
  state: ConversationState;
  normalizedText: string;
}

function normalizeMessage(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function findAgentByAlias(agents: AgentProfile[], alias: string): AgentProfile | undefined {
  return agents.find((agent) => agent.aliases.some((item) => item.toLowerCase() === alias.toLowerCase()));
}

function listEnabledAgents(config: RouterConfig): AgentProfile[] {
  return config.agents.filter((agent) => agent.enabled);
}

function stripLeadingSlashCommand(text: string): string {
  return text.trim().replace(/^\/\S+\s*/u, "").trim();
}

function isRecent(createdAt: string | undefined, stickyWindowMinutes: number): boolean {
  if (!createdAt || stickyWindowMinutes <= 0) {
    return false;
  }
  const createdAtMs = new Date(createdAt).getTime();
  if (Number.isNaN(createdAtMs)) {
    return false;
  }
  return Date.now() - createdAtMs <= stickyWindowMinutes * 60 * 1000;
}

function resolveStickyAgentId(
  state: ConversationState,
  agents: AgentProfile[],
  stickyWindowMinutes: number,
  currentMessageText: string
): string | undefined {
  const latestTurn = state.recentTurns[state.recentTurns.length - 1];
  const currentMessageAlreadySaved =
    latestTurn?.role === "user" && normalizeMessage(latestTurn.message) === currentMessageText;
  const priorTurns = currentMessageAlreadySaved ? state.recentTurns.slice(0, -1) : state.recentTurns;
  const latestSlashTurn = [...priorTurns].reverse().find((turn) => {
    if (turn.role !== "user") {
      return false;
    }
    return Boolean(parseCommand(turn.message).alias);
  });
  if (latestSlashTurn) {
    const parsed = parseCommand(latestSlashTurn.message);
    if (parsed.alias) {
      const matched = findAgentByAlias(agents, parsed.alias);
      return matched?.agentId;
    }
  }

  if (!state.activeAgentId) {
    return undefined;
  }

  const latestPriorTurn = priorTurns[priorTurns.length - 1];
  if (!latestPriorTurn || latestPriorTurn.role !== "assistant" || latestPriorTurn.agentId !== state.activeAgentId) {
    return undefined;
  }

  return isRecent(latestPriorTurn.createdAt, stickyWindowMinutes) ? state.activeAgentId : undefined;
}

export class RouterService {
  constructor(private readonly deps: RouterServiceDependencies) {}

  async decideRoute(message: InboundMessage): Promise<RoutedMessage> {
    const normalizedText = normalizeMessage(message.text);
    const parsed = parseCommand(normalizedText);
    const state = await this.deps.loadConversationState({
      ...message,
      text: normalizedText
    });
    const corrections = await this.deps.listCorrections(message.conversationId);
    const agents = listEnabledAgents(this.deps.config);
    const mainAgentId = this.deps.config.router.defaultMainAgentId;
    const stickyAgentWindowMinutes = this.deps.config.router.stickyAgentWindowMinutes ?? 180;

    if (parsed.alias) {
      const matched = findAgentByAlias(agents, parsed.alias);
      if (matched) {
        return {
          state,
          normalizedText: stripLeadingSlashCommand(normalizedText),
          decision: {
            targetAgentId: matched.agentId,
            reason: "explicit_command",
            confidence: 1,
            margin: 1,
            shouldSwitchActiveAgent: state.activeAgentId !== matched.agentId
          }
        };
      }
    }

    if (parsed.builtin === "all") {
      return {
        state,
        normalizedText,
        decision: {
          targetAgentId: mainAgentId,
          reason: "fallback_main",
          confidence: 1,
          margin: 1,
          shouldSwitchActiveAgent: false
        }
      };
    }

    const stickyAgentId = resolveStickyAgentId(state, agents, stickyAgentWindowMinutes, normalizedText);
    if (stickyAgentId) {
      return {
        state,
        normalizedText,
        decision: {
          targetAgentId: stickyAgentId,
          reason: "active_followup",
          confidence: 1,
          margin: 1,
          shouldSwitchActiveAgent: state.activeAgentId !== stickyAgentId
        }
      };
    }

    const classifierConfig = this.deps.config.router.classifier;
    const thresholds = {
      maxRecentTurns: classifierConfig.maxRecentTurns ?? 6,
      minConfidenceDirect: classifierConfig.minConfidenceDirect ?? 0.85,
      minConfidenceKeepActive: classifierConfig.minConfidenceKeepActive ?? 0.7,
      minMarginDirect: classifierConfig.minMarginDirect ?? 0.15,
      clarifyBelow: classifierConfig.clarifyBelow ?? 0.55
    };
    let classifierResponse = null;

    const preliminaryScores = computeCandidateScores(normalizedText, state, agents, null, corrections);
    const preliminaryMargin =
      preliminaryScores[0] && preliminaryScores[1]
        ? preliminaryScores[0].compositeScore - preliminaryScores[1].compositeScore
        : preliminaryScores[0]?.compositeScore ?? 0;

    const shouldCallClassifier =
      classifierConfig.enabled &&
      (
        !preliminaryScores[0]?.agentId ||
        (preliminaryScores[0]?.compositeScore ?? 0) < thresholds.minConfidenceDirect ||
        preliminaryMargin < thresholds.minMarginDirect
      );

    if (shouldCallClassifier) {
      try {
        classifierResponse = await this.deps.classifier.classify({
          message: normalizedText,
          recentTurns: state.recentTurns.slice(-thresholds.maxRecentTurns),
          activeAgentId: state.activeAgentId,
          topicSummary: state.topicSummary,
          candidateAgents: agents
        });
      } catch (error) {
        await this.deps.recordClassifierFailure?.(error);
        classifierResponse = null;
      }
    }

    const finalScores = computeCandidateScores(normalizedText, state, agents, classifierResponse, corrections);
    return {
      state,
      normalizedText,
      decision: mergeDecision(finalScores, state, classifierResponse, mainAgentId, {
        minConfidenceDirect: thresholds.minConfidenceDirect,
        minConfidenceKeepActive: thresholds.minConfidenceKeepActive,
        minMarginDirect: thresholds.minMarginDirect,
        clarifyBelow: thresholds.clarifyBelow
      })
    };
  }
}
