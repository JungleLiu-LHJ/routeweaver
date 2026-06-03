import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  channelId: text("channel_id").notNull(),
  userId: text("user_id").notNull(),
  activeAgentId: text("active_agent_id"),
  topicSummary: text("topic_summary"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
});

export const conversationTurns = sqliteTable("conversation_turns", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  role: text("role").notNull(),
  message: text("message").notNull(),
  agentId: text("agent_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

export const routeDecisions = sqliteTable("route_decisions", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  messageId: text("message_id").notNull(),
  targetAgentId: text("target_agent_id").notNull(),
  reason: text("reason").notNull(),
  confidence: real("confidence").notNull(),
  margin: real("margin"),
  scenarioLabel: text("scenario_label"),
  classifierProvider: text("classifier_provider"),
  classifierModel: text("classifier_model"),
  ruleScore: real("rule_score"),
  classifierScore: real("classifier_score"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

export const backendSessions = sqliteTable("backend_sessions", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  agentId: text("agent_id").notNull(),
  backendKind: text("backend_kind").notNull(),
  backendSessionRef: text("backend_session_ref").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
});

export const pushPreferences = sqliteTable("push_preferences", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  category: text("category").notNull(),
  muted: integer("muted", { mode: "boolean" }).notNull()
});

export const pushEvents = sqliteTable("push_events", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  category: text("category").notNull(),
  payload: text("payload").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

export const taskRefs = sqliteTable("task_refs", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  agentId: text("agent_id").notNull(),
  backendKind: text("backend_kind").notNull(),
  backendTaskRef: text("backend_task_ref").notNull(),
  status: text("status").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
});

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  eventType: text("event_type").notNull(),
  payload: text("payload").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

export const messageDedup = sqliteTable("message_dedup", {
  messageId: text("message_id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

export const routeCorrections = sqliteTable("route_corrections", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  messageSnippet: text("message_snippet").notNull(),
  predictedAgentId: text("predicted_agent_id").notNull(),
  correctedAgentId: text("corrected_agent_id").notNull(),
  scenarioLabel: text("scenario_label"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

export const channelBindings = sqliteTable("channel_bindings", {
  id: text("id").primaryKey(),
  routerUserId: text("router_user_id").notNull(),
  channelId: text("channel_id").notNull(),
  channelUserId: text("channel_user_id").notNull(),
  status: text("status").notNull(),
  token: text("token"),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
});

export const pendingConfirmations = sqliteTable("pending_confirmations", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  agentId: text("agent_id").notNull(),
  backendRef: text("backend_ref").notNull(),
  confirmationRef: text("confirmation_ref").notNull(),
  prompt: text("prompt").notNull(),
  originalMessage: text("original_message").notNull(),
  originalInputType: text("original_input_type"),
  originalMedia: text("original_media"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});
