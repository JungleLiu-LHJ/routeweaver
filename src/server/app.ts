import Fastify from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import type { BackendAdapter } from "../backends/base.js";
import { AcpBackendAdapter } from "../backends/acp.js";
import { HermesBackendAdapter } from "../backends/hermes.js";
import { OpenClawBackendAdapter } from "../backends/openclaw.js";
import { CustomHttpBackendAdapter } from "../backends/custom-http.js";
import { createOutboundTextSender } from "../channels/outbound.js";
import { WeChatChannelAdapter } from "../channels/wechat/adapter.js";
import { NullClassifierProvider, OpenAICompatibleClassifierProvider } from "../classifier/providers.js";
import type { RouterConfig } from "../config/schema.js";
import type { AgentProfile, BackendResponse, InboundMessage, RouteDecision } from "../domain/types.js";
import { RouterService } from "../router/service.js";
import { PushService, type PushRequest } from "../push/service.js";
import { SQLiteRouterRepository } from "../store/repositories.js";
import { TaskService } from "../tasks/service.js";

function createClassifier(config: RouterConfig) {
  const classifier = config.router.classifier;
  const apiKey = process.env.ROUTER_CLASSIFIER_API_KEY ?? process.env.OPENAI_API_KEY;
  const baseUrl = process.env.ROUTER_CLASSIFIER_BASE_URL
    ?? (classifier.model?.startsWith("deepseek-") ? "https://api.deepseek.com/v1" : "https://api.openai.com/v1");
  if (!classifier.enabled || classifier.provider !== "openai-compatible" || !classifier.model || !classifier.timeoutMs || !apiKey) {
    return new NullClassifierProvider();
  }
  return new OpenAICompatibleClassifierProvider({
    baseUrl,
    apiKey,
    model: classifier.model,
    timeoutMs: classifier.timeoutMs
  });
}

function createBackend(agent: AgentProfile, endpointByRef: Record<string, string>): BackendAdapter {
  switch (agent.backendKind) {
    case "hermes":
      return new HermesBackendAdapter(endpointByRef);
    case "openclaw":
      return new OpenClawBackendAdapter(endpointByRef);
    case "acp":
      return new AcpBackendAdapter(endpointByRef);
    case "custom-http":
      return new CustomHttpBackendAdapter(endpointByRef);
  }
}

function effectiveBackendUrl(agent: AgentProfile, endpointByRef: Record<string, string>): string | undefined {
  return agent.backendUrl ?? (agent.backendRef ? endpointByRef[agent.backendRef] : undefined);
}

function isConfirmText(text: string): boolean {
  return /^(确认|同意|继续|yes|y|confirm|ok)$/i.test(text.trim());
}

function isBindingCommand(text: string): string | undefined {
  const match = text.trim().match(/^\/bind\s+(\S+)/i);
  return match?.[1];
}

function extractCommandArgs(text: string): string[] {
  return text.trim().split(/\s+/).slice(1);
}

function authHeader(request: { headers: Record<string, string | string[] | undefined> }): string | undefined {
  const value = request.headers.authorization;
  return Array.isArray(value) ? value[0] : value;
}

function outboundText(channel: WeChatChannelAdapter, content: string): Promise<unknown> {
  return channel.formatOutbound({ content });
}

function stringField(data: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number") {
      return String(value);
    }
  }
  return undefined;
}

function parseClawBotInbound(payload: unknown): InboundMessage {
  const data = payload as Record<string, unknown>;
  const userId = stringField(data, "FromUserName", "fromUserName", "openid", "openId", "userId", "user_id", "senderId", "sender_id", "chatId", "chat_id");
  const text = stringField(data, "Content", "content", "text", "message", "msg");
  if (!userId || !text) {
    throw new Error("invalid ClawBot payload");
  }
  const messageId = stringField(data, "MsgId", "msgId", "messageId", "message_id", "id") ?? `clawbot:${userId}:${Date.now()}`;
  const conversationId = stringField(data, "conversationId", "conversation_id", "chatId", "chat_id") ?? userId;
  return {
    channelId: "wechat",
    userId,
    text,
    externalMessageId: messageId,
    conversationId: `wechat:${conversationId}`,
    inputType: "text"
  };
}

export function createApp(config: RouterConfig) {
  const app = Fastify({ logger: true });
  const repository = new SQLiteRouterRepository(config.storage.sqlitePath);
  const channel = new WeChatChannelAdapter();
  const outboundSender = createOutboundTextSender(config);
  const backendByAgentId = new Map(config.agents.map((agent) => [agent.agentId, createBackend(agent, config.backends.endpointByRef)]));
  const taskService = new TaskService(repository, backendByAgentId);
  const pushService = new PushService(
    repository,
    outboundSender,
    new Set(config.agents.flatMap((agent) => agent.pushCategories))
  );
  const router = new RouterService({
    config,
    classifier: createClassifier(config),
    loadConversationState: async (message) => repository.loadConversationState(message),
    listCorrections: async (conversationId) => repository.listCorrections(conversationId),
    recordClassifierFailure: async (error) => repository.writeAudit("classifier.failure", { error: String(error) })
  });

  void app.register(fastifyRateLimit, {
    max: 30,
    timeWindow: "1 minute"
  });

  app.addHook("onClose", async () => {
    repository.close();
  });

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async () => ({
    ok: true,
    agents: config.agents.filter((agent) => agent.enabled).length,
    storage: "sqlite"
  }));

  app.get("/admin/agents", async () => ({
    agents: config.agents.filter((agent) => agent.enabled && agent.listed).map((agent) => ({
      agentId: agent.agentId,
      displayName: agent.displayName,
      backendKind: agent.backendKind,
      aliases: agent.aliases,
      backendUrl: effectiveBackendUrl(agent, config.backends.endpointByRef),
      restartUrl: agent.restartUrl ?? null,
      healthUrl: agent.healthUrl ?? null,
      supportsRestart: Boolean(agent.restartUrl || effectiveBackendUrl(agent, config.backends.endpointByRef)),
      supportsHealthCheck: Boolean(agent.healthUrl || effectiveBackendUrl(agent, config.backends.endpointByRef))
    }))
  }));

  app.post("/admin/reload-config", async () => ({ reloaded: false, note: "Use process restart or inject a reloadable config provider." }));

  app.post("/admin/agents/:agentId/restart", async (request, reply) => {
    if (authHeader(request) !== `Bearer ${config.security.internalPushToken}`) {
      reply.code(401);
      return { ok: false, reason: "unauthorized" };
    }

    const { agentId } = request.params as { agentId: string };
    const agent = config.agents.find((item) => item.agentId === agentId && item.enabled);
    if (!agent) {
      reply.code(404);
      return { ok: false, reason: "agent_not_found" };
    }

    const backend = backendByAgentId.get(agent.agentId);
    if (!backend?.restartAgent) {
      reply.code(501);
      return { ok: false, reason: "restart_not_supported" };
    }

    const restarted = await backend.restartAgent(agent);
    if (!restarted) {
      reply.code(400);
      return { ok: false, reason: "restart_failed" };
    }

    await repository.writeAudit("agent.restart", { agentId: agent.agentId, backendKind: agent.backendKind });
    return { ok: true, agentId: agent.agentId };
  });

  app.post("/admin/bindings/wechat", async (request) => {
    const payload = request.body as { userId?: string; routerUserId?: string };
    if (!payload?.userId) {
      return { ok: false, error: "userId is required" };
    }
    return { ok: true, binding: await repository.bindChannel("wechat", payload.userId, payload.routerUserId ?? payload.userId) };
  });

  app.post("/admin/binding-token", async (request) => {
    const payload = request.body as { routerUserId?: string };
    if (!payload?.routerUserId) {
      return { ok: false, error: "routerUserId is required" };
    }
    const binding = await repository.createBindingToken(payload.routerUserId, config.wechat.bindingTokenTtlSeconds);
    return {
      ok: true,
      binding,
      bindCommand: `/bind ${binding.token}`,
      qrScene: binding.token,
      qrEvent: {
        Event: "SCAN",
        EventKey: binding.token
      }
    };
  });

  app.post("/admin/classify-preview", async (request) => {
    const payload = request.body as { text?: string };
    if (!payload?.text) {
      return { error: "text is required" };
    }
    const decision = await router.decideRoute({
      channelId: "wechat",
      userId: "preview",
      text: payload.text,
      externalMessageId: `preview:${Date.now()}`,
      conversationId: "preview"
    });
    return decision;
  });

  app.post("/internal/push", async (request, reply) => {
    if (authHeader(request) !== `Bearer ${config.security.internalPushToken}`) {
      reply.code(401);
      return { accepted: false, reason: "unauthorized" };
    }
    const result = await pushService.accept(request.body as PushRequest);
    await repository.writeAudit("push.result", { result });
    return result;
  });

  app.post("/internal/tasks/action", async (request, reply) => {
    if (authHeader(request) !== `Bearer ${config.security.internalPushToken}`) {
      reply.code(401);
      return { ok: false, reason: "unauthorized" };
    }
    const body = request.body as { taskId?: string; status?: "queued" | "running" | "completed" | "failed" | "cancelled" };
    if (!body?.taskId || !body.status) {
      return { ok: false, reason: "taskId and status are required" };
    }
    const result = await taskService.update(body.taskId, body.status);
    await repository.writeAudit("task.status", { taskId: body.taskId, status: body.status, result });
    return result;
  });

  app.post("/webhooks/wechat", async (request) => {
    return processInbound(await channel.parseInbound(request.body), false);
  });

  app.post("/webhooks/clawbot", async (request, reply) => {
    const query = request.query as { token?: string };
    const token = query.token ?? request.headers["x-hermes-router-token"];
    const tokenValue = Array.isArray(token) ? token[0] : token;
    if (authHeader(request) !== `Bearer ${config.security.internalPushToken}` && tokenValue !== config.security.internalPushToken) {
      reply.code(401);
      return { error: "unauthorized" };
    }
    return processInbound(parseClawBotInbound(request.body), true);
  });

  async function processInbound(inbound: InboundMessage, trustedAuthenticated: boolean): Promise<unknown> {
    if (await repository.isDuplicate(inbound.externalMessageId, inbound.conversationId)) {
      return { deduped: true };
    }

    const bindToken = isBindingCommand(inbound.text);
    if (bindToken) {
      const binding = await repository.consumeBindingToken(bindToken, inbound.channelId, inbound.userId);
      await repository.writeAudit(binding ? "binding.bound" : "binding.failed", { userId: inbound.userId });
      return outboundText(channel, binding ? "绑定成功。" : "绑定码无效或已过期。");
    }

    if (!trustedAuthenticated) {
      const allowed = config.security.allowlist.length === 0 || config.security.allowlist.includes(inbound.userId);
      const binding = await repository.findBinding(inbound.channelId, inbound.userId);
      if (!allowed || binding?.status !== "bound") {
        await repository.writeAudit("wechat.unauthorized", {
          userId: inbound.userId,
          allowed,
          bindingStatus: binding?.status ?? "missing"
        });
        return outboundText(channel, "请先完成绑定后再使用 Hermes Router。");
      }
    }

    await repository.saveUserTurn(inbound);
    const commandResponse = await handleBuiltInCommand(inbound);
    if (commandResponse) {
      await repository.saveAssistantTurn(inbound.conversationId, config.router.defaultMainAgentId, commandResponse, config.router.defaultMainAgentId);
      return outboundText(channel, commandResponse);
    }

    const pending = await repository.getPendingConfirmation(inbound.conversationId);
    if (pending) {
      if (!isConfirmText(inbound.text)) {
        return outboundText(channel, `有一个待确认操作：${pending.prompt}。回复“确认”继续，或 /reset 取消。`);
      }
      const agent = config.agents.find((item) => item.agentId === pending.agentId);
      const backend = agent ? backendByAgentId.get(agent.agentId) : undefined;
      if (!agent || !backend) {
        await repository.clearPendingConfirmation(inbound.conversationId);
        return outboundText(channel, "待确认操作已失效。");
      }
      const state = await repository.loadConversationState(inbound);
      const response = await backend.send({
        agent,
        message: pending.originalMessage,
        conversation: state,
        routeDecision: {
          targetAgentId: agent.agentId,
          reason: "active_followup",
          confidence: 1,
          shouldSwitchActiveAgent: false
        },
        confirmationRef: pending.confirmationRef,
        confirmed: true,
        inputType: pending.originalInputType,
        media: pending.originalMedia
      });
      await repository.clearPendingConfirmation(inbound.conversationId);
      return finalizeBackendResponse(inbound, agent, {
        targetAgentId: agent.agentId,
        reason: "active_followup",
        confidence: 1,
        shouldSwitchActiveAgent: false
      }, response);
    }

    const routed = await router.decideRoute(inbound);
    await repository.saveRouteDecision(inbound.conversationId, inbound.externalMessageId, routed.decision);
    await repository.writeAudit("route.decision", {
      conversationId: inbound.conversationId,
      messageId: inbound.externalMessageId,
      decision: routed.decision
    });
    if (routed.decision.reason === "clarify") {
      const responseText = "这个更像是哪一类？可以用 /agents 查看可用 agent，或直接使用 /main。";
      await repository.saveAssistantTurn(inbound.conversationId, routed.decision.targetAgentId, responseText, routed.state.activeAgentId ?? config.router.defaultMainAgentId);
      return outboundText(channel, responseText);
    }

    const agent = config.agents.find((item) => item.agentId === routed.decision.targetAgentId);
    const backend = agent ? backendByAgentId.get(agent.agentId) : undefined;
    if (!agent || !backend) {
      await repository.writeAudit("backend.missing", { agentId: routed.decision.targetAgentId });
      return outboundText(channel, "目标 agent 暂不可用。");
    }

    if (routed.decision.reason === "explicit_command" && !routed.normalizedText) {
      const responseText = `已切换到 ${agent.displayName}。`;
      await repository.saveAssistantTurn(inbound.conversationId, agent.agentId, responseText, agent.agentId);
      return outboundText(channel, responseText);
    }

    try {
      const response = await backend.send({
        agent,
        message: routed.normalizedText,
        conversation: routed.state,
        routeDecision: routed.decision,
        inputType: inbound.inputType,
        media: inbound.media
      });
      await repository.writeAudit("backend.response", { agentId: agent.agentId, response });
      return finalizeBackendResponse(inbound, agent, routed.decision, response);
    } catch (error) {
      await repository.writeAudit("backend.failure", { agentId: agent.agentId, error: String(error) });
      const responseText = `后端 ${agent.displayName} 暂时不可用。`;
      await repository.saveAssistantTurn(inbound.conversationId, agent.agentId, responseText, routed.state.activeAgentId ?? config.router.defaultMainAgentId);
      return outboundText(channel, responseText);
    }
  }

  async function handleBuiltInCommand(inbound: InboundMessage): Promise<string | undefined> {
    const text = inbound.text.trim();
    const lower = text.toLowerCase();
    const state = await repository.loadConversationState(inbound);
    if (lower === "/main") {
      return "已切回 Main Agent。";
    }
    if (lower === "/status") {
      return `当前 agent: ${state.activeAgentId ?? config.router.defaultMainAgentId}`;
    }
    if (lower === "/reset") {
      await repository.clearConversation(inbound.conversationId);
      return "已清空当前会话状态。";
    }
    if (lower === "/agents") {
      return config.agents.filter((agent) => agent.enabled && agent.listed).map((agent) => `/${agent.aliases[0] ?? agent.agentId} ${agent.displayName}`).join("\n");
    }
    if (lower === "/all") {
      return config.agents.filter((agent) => agent.enabled).map((agent) => agent.displayName).join(", ");
    }
    if (lower.startsWith("/push")) {
      const [action, category] = extractCommandArgs(text);
      if (action === "status" || action === "list") {
        const prefs = await repository.listPushPreferences(inbound.userId);
        return prefs.length ? prefs.map((pref) => `${pref.category}: ${pref.muted ? "muted" : "on"}`).join("\n") : "没有静音的 push category。";
      }
      if ((action === "mute" || action === "unmute") && category) {
        await repository.setPushMuted(inbound.userId, category, action === "mute");
        return `${category} 已${action === "mute" ? "静音" : "取消静音"}。`;
      }
      return "用法：/push status | /push list | /push mute <category> | /push unmute <category>";
    }
    if (lower.startsWith("/tasks")) {
      const [action, taskId] = extractCommandArgs(text);
      const tasks = await taskService.list(inbound.conversationId);
      if (action === "stop" && taskId) {
        const result = await taskService.stop(taskId, tasks);
        return result.ok ? "任务已停止。" : `停止失败：${result.reason ?? "unknown"}`;
      }
      return tasks.length ? tasks.map((task) => `${task.id} ${task.agentId} ${task.status} ${task.backendTaskRef}`).join("\n") : "当前没有任务。";
    }
    return undefined;
  }

  async function finalizeBackendResponse(inbound: InboundMessage, agent: AgentProfile, decision: RouteDecision, response: BackendResponse): Promise<unknown> {
    const activeAgentId = decision.shouldSwitchActiveAgent ? decision.targetAgentId : (await repository.loadConversationState(inbound)).activeAgentId ?? decision.targetAgentId;
    if (response.requiresConfirmation) {
      const prompt = response.confirmationText ?? response.content;
      await repository.savePendingConfirmation({
        conversationId: inbound.conversationId,
        agentId: agent.agentId,
        backendRef: agent.backendRef ?? agent.backendUrl ?? agent.agentId,
        confirmationRef: response.confirmationRef ?? `${agent.agentId}:${Date.now()}`,
        prompt,
        originalMessage: inbound.text,
        originalInputType: inbound.inputType,
        originalMedia: inbound.media
      });
      await repository.writeAudit("confirmation.pending", { agentId: agent.agentId, prompt });
      await repository.saveAssistantTurn(inbound.conversationId, agent.agentId, prompt, activeAgentId);
      return outboundText(channel, prompt);
    }
    if (response.taskRef) {
      await repository.saveTask({
        conversationId: inbound.conversationId,
        agentId: agent.agentId,
        backendKind: agent.backendKind,
        backendTaskRef: response.taskRef,
        status: response.taskStatus ?? "queued"
      });
    }
    const content = response.content || (response.taskRef ? `任务已提交：${response.taskRef}` : "");
    await repository.saveAssistantTurn(inbound.conversationId, agent.agentId, content, activeAgentId);
    return outboundText(channel, content);
  }

  return app;
}
