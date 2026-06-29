import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  ChannelBinding,
  ConversationState,
  InboundMessage,
  PendingConfirmation,
  RouteCorrectionHint,
  RouteDecision,
  RouterTurn,
  TaskRef
} from "../domain/types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function id(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function isoToMs(value?: string): number | null {
  return value ? new Date(value).getTime() : null;
}

function msToIso(value: unknown): string | undefined {
  return typeof value === "number" ? new Date(value).toISOString() : undefined;
}

interface ConversationRow {
  id: string;
  channel_id: string;
  user_id: string;
  active_agent_id: string | null;
  topic_summary: string | null;
}

interface TurnRow {
  role: "user" | "assistant" | "system";
  message: string;
  agent_id: string | null;
  created_at: number;
}

interface CorrectionRow {
  predicted_agent_id: string;
  corrected_agent_id: string;
  message_snippet: string;
  scenario_label: string | null;
}

interface BindingRow {
  router_user_id: string;
  channel_id: string;
  channel_user_id: string;
  status: ChannelBinding["status"];
  token: string | null;
  expires_at: number | null;
}

interface ConfirmationRow {
  id: string;
  conversation_id: string;
  agent_id: string;
  backend_ref: string;
  confirmation_ref: string;
  prompt: string;
  original_message: string;
  original_input_type: InboundMessage["inputType"] | null;
  original_media: string | null;
  created_at: number;
}

interface TaskRow {
  id: string;
  conversation_id: string;
  agent_id: string;
  backend_kind: TaskRef["backendKind"];
  backend_task_ref: string;
  status: TaskRef["status"];
  created_at: number;
  updated_at: number;
}

export class InMemoryConversationRepository {
  private readonly conversations = new Map<string, ConversationState>();
  private readonly corrections = new Map<string, RouteCorrectionHint[]>();
  private readonly dedup = new Set<string>();

  async isDuplicate(messageId: string): Promise<boolean> {
    if (this.dedup.has(messageId)) {
      return true;
    }
    this.dedup.add(messageId);
    return false;
  }

  async loadConversationState(message: InboundMessage): Promise<ConversationState> {
    const existing = this.conversations.get(message.conversationId);
    if (existing) {
      return existing;
    }

    const created: ConversationState = {
      conversationId: message.conversationId,
      channelId: message.channelId,
      userId: message.userId,
      recentTurns: []
    };
    this.conversations.set(message.conversationId, created);
    return created;
  }

  async saveAssistantTurn(conversationId: string, agentId: string, message: string, activeAgentId: string): Promise<void> {
    const state = this.conversations.get(conversationId);
    if (!state) {
      return;
    }
    state.recentTurns = [...state.recentTurns, { role: "assistant" as const, message, agentId, createdAt: nowIso() }].slice(-12);
    state.activeAgentId = activeAgentId;
  }

  async setActiveAgent(conversationId: string, activeAgentId: string): Promise<void> {
    const state = this.conversations.get(conversationId);
    if (state) {
      state.activeAgentId = activeAgentId;
    }
  }

  async saveUserTurn(message: InboundMessage): Promise<void> {
    const state = await this.loadConversationState(message);
    state.recentTurns = [...state.recentTurns, { role: "user" as const, message: message.text, createdAt: nowIso() }].slice(-12);
  }

  async listCorrections(conversationId: string): Promise<RouteCorrectionHint[]> {
    return this.corrections.get(conversationId) ?? [];
  }
}

export class SQLiteRouterRepository {
  private readonly db: Database;

  constructor(sqlitePath: string) {
    if (sqlitePath !== ":memory:") {
      mkdirSync(dirname(sqlitePath), { recursive: true });
    }
    this.db = new Database(sqlitePath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  async isDuplicate(messageId: string, conversationId: string): Promise<boolean> {
    const existing = this.db.prepare("select message_id from message_dedup where message_id = ?").get(messageId);
    if (existing) {
      return true;
    }
    this.db.prepare("insert into message_dedup (message_id, conversation_id, created_at) values (?, ?, ?)").run(messageId, conversationId, Date.now());
    return false;
  }

  async loadConversationState(message: InboundMessage): Promise<ConversationState> {
    const existing = this.db.prepare("select * from conversations where id = ?").get(message.conversationId) as ConversationRow | undefined;
    if (!existing) {
      const now = Date.now();
      this.db.prepare("insert into conversations (id, channel_id, user_id, active_agent_id, topic_summary, created_at, updated_at) values (?, ?, ?, null, null, ?, ?)").run(
        message.conversationId,
        message.channelId,
        message.userId,
        now,
        now
      );
    }

    const row = (existing ?? this.db.prepare("select * from conversations where id = ?").get(message.conversationId)) as ConversationRow;
    const turns = this.db.prepare("select role, message, agent_id, created_at from conversation_turns where conversation_id = ? order by created_at desc, rowid desc limit 12").all(message.conversationId) as TurnRow[];
    return {
      conversationId: row.id,
      channelId: row.channel_id as ConversationState["channelId"],
      userId: row.user_id,
      activeAgentId: row.active_agent_id ?? undefined,
      topicSummary: row.topic_summary ?? undefined,
      recentTurns: turns.reverse().map((turn) => ({
        role: turn.role,
        message: turn.message,
        agentId: turn.agent_id ?? undefined,
        createdAt: new Date(turn.created_at).toISOString()
      }))
    };
  }

  async saveUserTurn(message: InboundMessage): Promise<void> {
    await this.loadConversationState(message);
    this.insertTurn(message.conversationId, "user", message.text);
  }

  async saveAssistantTurn(conversationId: string, agentId: string, message: string, activeAgentId: string): Promise<void> {
    this.insertTurn(conversationId, "assistant", message, agentId);
    this.db.prepare("update conversations set active_agent_id = ?, updated_at = ? where id = ?").run(activeAgentId, Date.now(), conversationId);
  }

  async setActiveAgent(conversationId: string, activeAgentId: string): Promise<void> {
    this.db.prepare("update conversations set active_agent_id = ?, updated_at = ? where id = ?").run(activeAgentId, Date.now(), conversationId);
  }

  async clearConversation(conversationId: string): Promise<void> {
    this.db.prepare("delete from conversation_turns where conversation_id = ?").run(conversationId);
    this.db.prepare("delete from pending_confirmations where conversation_id = ?").run(conversationId);
    this.db.prepare("update conversations set active_agent_id = null, topic_summary = null, updated_at = ? where id = ?").run(Date.now(), conversationId);
  }

  async saveRouteDecision(conversationId: string, messageId: string, decision: RouteDecision): Promise<void> {
    this.db.prepare(`
      insert into route_decisions (id, conversation_id, message_id, target_agent_id, reason, confidence, margin, scenario_label, classifier_provider, classifier_model, rule_score, classifier_score, created_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, null, null, null, null, ?)
    `).run(id("route"), conversationId, messageId, decision.targetAgentId, decision.reason, decision.confidence, decision.margin ?? null, decision.scenarioLabel ?? null, Date.now());
  }

  async listCorrections(conversationId: string): Promise<RouteCorrectionHint[]> {
    const rows = this.db.prepare("select predicted_agent_id, corrected_agent_id, message_snippet, scenario_label from route_corrections where conversation_id = ? order by created_at desc limit 10").all(conversationId) as CorrectionRow[];
    return rows.map((row) => ({
      predictedAgentId: row.predicted_agent_id,
      correctedAgentId: row.corrected_agent_id,
      messageSnippet: row.message_snippet,
      scenarioLabel: row.scenario_label ?? undefined
    }));
  }

  async findBinding(channelId: string, channelUserId: string): Promise<ChannelBinding | undefined> {
    const row = this.db.prepare("select * from channel_bindings where channel_id = ? and channel_user_id = ? order by updated_at desc limit 1").get(channelId, channelUserId) as BindingRow | undefined;
    return row ? this.mapBinding(row) : undefined;
  }

  async bindChannel(channelId: string, channelUserId: string, routerUserId = channelUserId): Promise<ChannelBinding> {
    const binding: ChannelBinding = { routerUserId, channelId: channelId as ChannelBinding["channelId"], channelUserId, status: "bound" };
    const now = Date.now();
    this.db.prepare(`
      insert into channel_bindings (id, router_user_id, channel_id, channel_user_id, status, token, expires_at, created_at, updated_at)
      values (?, ?, ?, ?, 'bound', null, null, ?, ?)
    `).run(id("binding"), routerUserId, channelId, channelUserId, now, now);
    return binding;
  }

  async createBindingToken(routerUserId: string, ttlSeconds: number): Promise<ChannelBinding> {
    const token = id("bind");
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    this.db.prepare(`
      insert into channel_bindings (id, router_user_id, channel_id, channel_user_id, status, token, expires_at, created_at, updated_at)
      values (?, ?, 'wechat', '', 'pending', ?, ?, ?, ?)
    `).run(id("binding"), routerUserId, token, isoToMs(expiresAt), Date.now(), Date.now());
    return { routerUserId, channelId: "wechat", channelUserId: "", status: "pending", token, expiresAt };
  }

  async consumeBindingToken(token: string, channelId: string, channelUserId: string): Promise<ChannelBinding | undefined> {
    const row = this.db.prepare("select * from channel_bindings where token = ? and status = 'pending'").get(token) as BindingRow | undefined;
    if (!row || (row.expires_at && row.expires_at < Date.now())) {
      if (row) {
        this.db.prepare("update channel_bindings set status = 'expired', updated_at = ? where token = ?").run(Date.now(), token);
      }
      return undefined;
    }
    this.db.prepare("update channel_bindings set channel_id = ?, channel_user_id = ?, status = 'bound', updated_at = ? where token = ?").run(channelId, channelUserId, Date.now(), token);
    return {
      routerUserId: row.router_user_id,
      channelId: channelId as ChannelBinding["channelId"],
      channelUserId,
      status: "bound",
      token
    };
  }

  async getPushMuted(userId: string, category: string): Promise<boolean> {
    const row = this.db.prepare("select muted from push_preferences where user_id = ? and category = ?").get(userId, category) as { muted: number } | undefined;
    return Boolean(row?.muted);
  }

  async setPushMuted(userId: string, category: string, muted: boolean): Promise<void> {
    this.db.prepare("delete from push_preferences where user_id = ? and category = ?").run(userId, category);
    this.db.prepare("insert into push_preferences (id, user_id, category, muted) values (?, ?, ?, ?)").run(id("pref"), userId, category, muted ? 1 : 0);
  }

  async listPushPreferences(userId: string): Promise<Array<{ category: string; muted: boolean }>> {
    return this.db.prepare("select category, muted from push_preferences where user_id = ? order by category").all(userId).map((row) => {
      const data = row as { category: string; muted: number };
      return { category: data.category, muted: Boolean(data.muted) };
    });
  }

  async recordPushEvent(userId: string, category: string, payload: Record<string, unknown>): Promise<void> {
    this.db.prepare("insert into push_events (id, user_id, category, payload, created_at) values (?, ?, ?, ?, ?)").run(id("push"), userId, category, JSON.stringify(payload), Date.now());
  }

  async isPushDuplicate(dedupeKey: string): Promise<boolean> {
    const messageId = `push:${dedupeKey}`;
    const existing = this.db.prepare("select message_id from message_dedup where message_id = ?").get(messageId);
    if (existing) {
      return true;
    }
    this.db.prepare("insert into message_dedup (message_id, conversation_id, created_at) values (?, ?, ?)").run(messageId, "internal:push", Date.now());
    return false;
  }

  async saveTask(task: Omit<TaskRef, "id" | "createdAt" | "updatedAt">): Promise<TaskRef> {
    const createdAt = nowIso();
    const saved: TaskRef = { ...task, id: id("task"), createdAt, updatedAt: createdAt };
    this.db.prepare(`
      insert into task_refs (id, conversation_id, agent_id, backend_kind, backend_task_ref, status, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(saved.id, saved.conversationId, saved.agentId, saved.backendKind, saved.backendTaskRef, saved.status, isoToMs(saved.createdAt), isoToMs(saved.updatedAt));
    return saved;
  }

  async listTasks(conversationId: string): Promise<TaskRef[]> {
    const rows = this.db.prepare("select * from task_refs where conversation_id = ? order by created_at desc limit 20").all(conversationId) as TaskRow[];
    return rows.map((row) => this.mapTask(row));
  }

  async updateTaskStatus(taskId: string, status: TaskRef["status"]): Promise<boolean> {
    const now = Date.now();
    const byId = this.db.prepare("update task_refs set status = ?, updated_at = ? where id = ?").run(status, now, taskId);
    if (byId.changes > 0) {
      return true;
    }
    return this.db.prepare("update task_refs set status = ?, updated_at = ? where backend_task_ref = ?").run(status, now, taskId).changes > 0;
  }

  async getPendingConfirmation(conversationId: string): Promise<PendingConfirmation | undefined> {
    const row = this.db.prepare("select * from pending_confirmations where conversation_id = ? order by created_at desc limit 1").get(conversationId) as ConfirmationRow | undefined;
    return row ? this.mapConfirmation(row) : undefined;
  }

  async savePendingConfirmation(input: Omit<PendingConfirmation, "id" | "createdAt">): Promise<PendingConfirmation> {
    await this.clearPendingConfirmation(input.conversationId);
    const saved: PendingConfirmation = { ...input, id: id("confirm"), createdAt: nowIso() };
    this.db.prepare(`
      insert into pending_confirmations (
        id, conversation_id, agent_id, backend_ref, confirmation_ref, prompt, original_message, original_input_type, original_media, created_at
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      saved.id,
      saved.conversationId,
      saved.agentId,
      saved.backendRef,
      saved.confirmationRef,
      saved.prompt,
      saved.originalMessage,
      saved.originalInputType ?? null,
      saved.originalMedia ? JSON.stringify(saved.originalMedia) : null,
      isoToMs(saved.createdAt)
    );
    return saved;
  }

  async clearPendingConfirmation(conversationId: string): Promise<void> {
    this.db.prepare("delete from pending_confirmations where conversation_id = ?").run(conversationId);
  }

  async writeAudit(eventType: string, payload: Record<string, unknown>): Promise<void> {
    this.db.prepare("insert into audit_events (id, event_type, payload, created_at) values (?, ?, ?, ?)").run(id("audit"), eventType, JSON.stringify(payload), Date.now());
  }

  private insertTurn(conversationId: string, role: RouterTurn["role"], message: string, agentId?: string): void {
    this.db.prepare("insert into conversation_turns (id, conversation_id, role, message, agent_id, created_at) values (?, ?, ?, ?, ?, ?)").run(
      id("turn"),
      conversationId,
      role,
      message,
      agentId ?? null,
      Date.now()
    );
    this.db.prepare("update conversations set updated_at = ? where id = ?").run(Date.now(), conversationId);
  }

  private mapBinding(row: BindingRow): ChannelBinding {
    return {
      routerUserId: row.router_user_id,
      channelId: row.channel_id as ChannelBinding["channelId"],
      channelUserId: row.channel_user_id,
      status: row.status,
      token: row.token ?? undefined,
      expiresAt: msToIso(row.expires_at)
    };
  }

  private mapConfirmation(row: ConfirmationRow): PendingConfirmation {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      agentId: row.agent_id,
      backendRef: row.backend_ref,
      confirmationRef: row.confirmation_ref,
      prompt: row.prompt,
      originalMessage: row.original_message,
      originalInputType: row.original_input_type ?? undefined,
      originalMedia: row.original_media ? JSON.parse(row.original_media) as InboundMessage["media"] : undefined,
      createdAt: new Date(row.created_at).toISOString()
    };
  }

  private mapTask(row: TaskRow): TaskRef {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      agentId: row.agent_id,
      backendKind: row.backend_kind,
      backendTaskRef: row.backend_task_ref,
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString()
    };
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists conversations (
        id text primary key,
        channel_id text not null,
        user_id text not null,
        active_agent_id text,
        topic_summary text,
        created_at integer not null,
        updated_at integer not null
      );
      create table if not exists conversation_turns (
        id text primary key,
        conversation_id text not null,
        role text not null,
        message text not null,
        agent_id text,
        created_at integer not null
      );
      create table if not exists route_decisions (
        id text primary key,
        conversation_id text not null,
        message_id text not null,
        target_agent_id text not null,
        reason text not null,
        confidence real not null,
        margin real,
        scenario_label text,
        classifier_provider text,
        classifier_model text,
        rule_score real,
        classifier_score real,
        created_at integer not null
      );
      create table if not exists push_preferences (
        id text primary key,
        user_id text not null,
        category text not null,
        muted integer not null
      );
      create table if not exists push_events (
        id text primary key,
        user_id text not null,
        category text not null,
        payload text not null,
        created_at integer not null
      );
      create table if not exists task_refs (
        id text primary key,
        conversation_id text not null,
        agent_id text not null,
        backend_kind text not null,
        backend_task_ref text not null,
        status text not null,
        created_at integer not null,
        updated_at integer not null
      );
      create table if not exists audit_events (
        id text primary key,
        event_type text not null,
        payload text not null,
        created_at integer not null
      );
      create table if not exists message_dedup (
        message_id text primary key,
        conversation_id text not null,
        created_at integer not null
      );
      create table if not exists route_corrections (
        id text primary key,
        conversation_id text not null,
        message_snippet text not null,
        predicted_agent_id text not null,
        corrected_agent_id text not null,
        scenario_label text,
        created_at integer not null
      );
      create table if not exists channel_bindings (
        id text primary key,
        router_user_id text not null,
        channel_id text not null,
        channel_user_id text not null,
        status text not null,
        token text,
        expires_at integer,
        created_at integer not null,
        updated_at integer not null
      );
      create table if not exists pending_confirmations (
        id text primary key,
        conversation_id text not null,
        agent_id text not null,
        backend_ref text not null,
        confirmation_ref text not null,
        prompt text not null,
        original_message text not null,
        original_input_type text,
        original_media text,
        created_at integer not null
      );
    `);

    const confirmationColumns = this.db.prepare("pragma table_info(pending_confirmations)").all() as Array<{ name: string }>;
    const confirmationColumnNames = new Set(confirmationColumns.map((column) => column.name));
    if (!confirmationColumnNames.has("original_input_type")) {
      this.db.exec("alter table pending_confirmations add column original_input_type text");
    }
    if (!confirmationColumnNames.has("original_media")) {
      this.db.exec("alter table pending_confirmations add column original_media text");
    }
  }
}
