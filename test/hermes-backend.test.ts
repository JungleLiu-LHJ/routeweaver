import { afterEach, describe, expect, it, vi } from "vitest";
import { HermesBackendAdapter } from "../src/backends/hermes.js";
import type { BackendRequest } from "../src/domain/types.js";

function makeRequest(): BackendRequest {
  return {
    agent: {
      agentId: "finance",
      displayName: "Finance Hermes",
      description: "finance",
      backendKind: "hermes",
      backendRef: "hermes-finance",
      aliases: ["finance"],
      capabilityTags: ["finance"],
      keywordHints: ["budget"],
      pushCategories: ["finance_alert"],
      enabled: true,
      listed: true,
      riskLevel: "medium"
    },
    message: "帮我看预算",
    conversation: {
      conversationId: "wechat:u1",
      channelId: "wechat",
      userId: "u1",
      activeAgentId: "finance",
      recentTurns: []
    },
    routeDecision: {
      targetAgentId: "finance",
      reason: "explicit_command",
      confidence: 1,
      shouldSwitchActiveAgent: true,
      scenarioLabel: "budget review"
    },
    inputType: "voice",
    media: {
      mediaId: "mid-voice-1",
      format: "amr",
      recognitionText: "帮我看预算"
    }
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("HermesBackendAdapter", () => {
  it("sends native hermes_router adapter payload instead of OpenAI chat completions", async () => {
    vi.stubEnv("HERMES_ROUTER_ADAPTER_TOKEN", "adapter-token");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      content: "ok",
      taskRef: "task-1",
      taskStatus: "running"
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new HermesBackendAdapter({
      "hermes-finance": "http://127.0.0.1:8788/hermes-router/message"
    });
    const response = await adapter.send(makeRequest());

    expect(response).toMatchObject({ content: "ok", taskRef: "task-1", taskStatus: "running" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8788/hermes-router/message");
    expect(init.headers).toMatchObject({ authorization: "Bearer adapter-token" });
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      responseMode: "async",
      profile: "finance",
      agentId: "finance",
      message: "帮我看预算",
      inputType: "voice",
      media: {
        mediaId: "mid-voice-1",
        format: "amr",
        recognitionText: "帮我看预算"
      },
      conversationId: "wechat:u1",
      userId: "u1",
      sourceChannel: "wechat",
      scenarioLabel: "budget review"
    });
    expect(body).not.toHaveProperty("messages");
    expect(body).not.toHaveProperty("model");
  });

  it("fails fast when the hermes async submit request times out", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"));
      });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new HermesBackendAdapter({
      "hermes-finance": "http://127.0.0.1:8788/hermes-router/message"
    });
    const pending = expect(adapter.send(makeRequest())).rejects.toThrow("hermes submit timeout after 3000ms");

    await vi.advanceTimersByTimeAsync(3_000);
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("prefers inline backendUrl when provided on the agent", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      content: "ok"
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new HermesBackendAdapter({});
    const request = makeRequest();
    request.agent.backendRef = undefined;
    request.agent.backendUrl = "http://127.0.0.1:9000/hermes-router/message";

    await adapter.send(request);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:9000/hermes-router/message");
  });
});
