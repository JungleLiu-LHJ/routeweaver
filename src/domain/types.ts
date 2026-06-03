export type ChannelId = "wechat" | "telegram" | "whatsapp" | "web" | "cli";
export type BackendKind = "hermes" | "openclaw" | "acp" | "custom-http";

export interface AgentProfile {
  agentId: string;
  displayName: string;
  description: string;
  backendKind: BackendKind;
  backendRef: string;
  aliases: string[];
  capabilityTags: string[];
  keywordHints: string[];
  scenarioHints?: string[];
  pushCategories: string[];
  enabled: boolean;
  listed: boolean;
  isMain?: boolean;
  riskLevel: "low" | "medium" | "high";
}

export interface RouterTurn {
  role: "user" | "assistant" | "system";
  message: string;
  agentId?: string;
  createdAt: string;
}

export interface RouteDecision {
  targetAgentId: string;
  reason:
    | "explicit_command"
    | "active_followup"
    | "keyword_rule"
    | "llm_classifier"
    | "fallback_main"
    | "clarify";
  confidence: number;
  margin?: number;
  shouldSwitchActiveAgent: boolean;
  scenarioLabel?: string;
}

export interface RouterClassifierRequest {
  message: string;
  recentTurns: RouterTurn[];
  activeAgentId?: string;
  topicSummary?: string;
  candidateAgents: AgentProfile[];
}

export interface RouterClassifierAlternative {
  agentId: string;
  score: number;
}

export interface RouterClassifierResponse {
  topAgentId: string | null;
  confidence: number;
  margin?: number;
  scenarioLabel?: string;
  reasoningTags: string[];
  alternatives: RouterClassifierAlternative[];
  shouldClarify?: boolean;
}

export interface ConversationState {
  conversationId: string;
  channelId: ChannelId;
  userId: string;
  activeAgentId?: string;
  topicSummary?: string;
  recentTurns: RouterTurn[];
}

export interface InboundMessage {
  channelId: ChannelId;
  userId: string;
  text: string;
  externalMessageId: string;
  conversationId: string;
  inputType?: "text" | "image" | "voice";
  media?: {
    mediaId?: string;
    url?: string;
    format?: string;
    recognitionText?: string;
  };
}

export interface BackendRequest {
  agent: AgentProfile;
  message: string;
  conversation: ConversationState;
  routeDecision: RouteDecision;
  confirmationRef?: string;
  confirmed?: boolean;
  inputType?: InboundMessage["inputType"];
  media?: InboundMessage["media"];
}

export interface BackendResponse {
  content: string;
  taskRef?: string;
  taskStatus?: "queued" | "running" | "completed" | "failed" | "cancelled";
  requiresConfirmation?: boolean;
  confirmationText?: string;
  confirmationRef?: string;
  raw?: unknown;
}

export interface RouteCorrectionHint {
  predictedAgentId: string;
  correctedAgentId: string;
  messageSnippet: string;
  scenarioLabel?: string;
}

export interface ChannelBinding {
  routerUserId: string;
  channelId: ChannelId;
  channelUserId: string;
  status: "pending" | "scanned" | "bound" | "expired" | "cancelled";
  token?: string;
  expiresAt?: string;
}

export interface PendingConfirmation {
  id: string;
  conversationId: string;
  agentId: string;
  backendRef: string;
  confirmationRef: string;
  prompt: string;
  originalMessage: string;
  originalInputType?: InboundMessage["inputType"];
  originalMedia?: InboundMessage["media"];
  createdAt: string;
}

export interface TaskRef {
  id: string;
  conversationId: string;
  agentId: string;
  backendKind: BackendKind;
  backendTaskRef: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
}
