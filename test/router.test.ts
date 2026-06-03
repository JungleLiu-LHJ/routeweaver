import { describe, expect, it } from "vitest";
import { RouterService } from "../src/router/service.js";
import type { ConversationState, RouterClassifierResponse } from "../src/domain/types.js";
import type { RouterConfig } from "../src/config/schema.js";

const config: RouterConfig = {
  router: {
    defaultMainAgentId: "main",
    stickyAgentWindowMinutes: 180,
    classifier: {
      enabled: true,
      provider: "openai-compatible",
      model: "gpt-4.1-mini",
      timeoutMs: 2500,
      maxRecentTurns: 6,
      minConfidenceDirect: 0.85,
      minConfidenceKeepActive: 0.7,
      minMarginDirect: 0.15,
      clarifyBelow: 0.55
    }
  },
  agents: [
    {
      agentId: "main",
      displayName: "Main",
      description: "fallback",
      backendKind: "hermes",
      backendRef: "main",
      aliases: ["main"],
      capabilityTags: ["general"],
      keywordHints: [],
      scenarioHints: ["general"],
      pushCategories: [],
      enabled: true,
      listed: true,
      isMain: true,
      riskLevel: "low"
    },
    {
      agentId: "coding",
      displayName: "Coding",
      description: "debugging",
      backendKind: "acp",
      backendRef: "codex",
      aliases: ["code", "dev"],
      capabilityTags: ["coding"],
      keywordHints: ["bug", "kafka", "offset", "repo"],
      scenarioHints: ["debugging", "code review"],
      pushCategories: [],
      enabled: true,
      listed: true,
      riskLevel: "medium"
    },
    {
      agentId: "travel",
      displayName: "Travel",
      description: "trip planning",
      backendKind: "openclaw",
      backendRef: "travel",
      aliases: ["travel"],
      capabilityTags: ["travel"],
      keywordHints: ["flight", "hotel", "budget"],
      scenarioHints: ["trip planning", "weekend itinerary"],
      pushCategories: [],
      enabled: true,
      listed: true,
      riskLevel: "low"
    }
  ]
};

function makeState(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    conversationId: "c1",
    channelId: "wechat",
    userId: "u1",
    activeAgentId: "travel",
    topicSummary: "planning a trip",
    recentTurns: [
      {
        role: "assistant",
        message: "We can plan Tokyo next.",
        agentId: "travel",
        createdAt: new Date().toISOString()
      }
    ],
    ...overrides
  };
}

function makeService(classifierResponse: RouterClassifierResponse | Error | null, state: ConversationState) {
  return new RouterService({
    config,
    classifier: {
      async classify() {
        if (classifierResponse instanceof Error) {
          throw classifierResponse;
        }
        return classifierResponse ?? {
          topAgentId: null,
          confidence: 0,
          reasoningTags: [],
          alternatives: []
        };
      }
    },
    loadConversationState: async () => state,
    listCorrections: async () => []
  });
}

describe("RouterService", () => {
  it("lets explicit alias beat semantic routing", async () => {
    const service = makeService({
      topAgentId: "travel",
      confidence: 0.99,
      reasoningTags: ["semantic"],
      alternatives: [{ agentId: "travel", score: 0.99 }]
    }, makeState());

    const result = await service.decideRoute({
      channelId: "wechat",
      userId: "u1",
      text: "/dev 帮我看看",
      externalMessageId: "m1",
      conversationId: "c1"
    });

    expect(result.decision.targetAgentId).toBe("coding");
    expect(result.decision.reason).toBe("explicit_command");
    expect(result.normalizedText).toBe("帮我看看");
  });

  it("does not forward an alias-only command as a Hermes slash command", async () => {
    const service = makeService(null, makeState());

    const result = await service.decideRoute({
      channelId: "wechat",
      userId: "u1",
      text: "/dev",
      externalMessageId: "m1-alias-only",
      conversationId: "c1"
    });

    expect(result.decision.targetAgentId).toBe("coding");
    expect(result.decision.reason).toBe("explicit_command");
    expect(result.normalizedText).toBe("");
  });

  it("keeps active agent when switch evidence is below threshold", async () => {
    const service = makeService({
      topAgentId: "coding",
      confidence: 0.79,
      margin: 0.08,
      reasoningTags: ["mixed"],
      alternatives: [
        { agentId: "coding", score: 0.79 },
        { agentId: "travel", score: 0.71 }
      ]
    }, makeState());

    const result = await service.decideRoute({
      channelId: "wechat",
      userId: "u1",
      text: "这个顺便看看 kafka offset 为什么没提交",
      externalMessageId: "m2",
      conversationId: "c1"
    });

    expect(result.decision.targetAgentId).toBe("travel");
    expect(result.decision.reason).toBe("active_followup");
  });

  it("sticks to the previous agent within the configured window", async () => {
    const service = makeService({
      topAgentId: "main",
      confidence: 0.95,
      margin: 0.6,
      reasoningTags: ["semantic"],
      alternatives: [{ agentId: "main", score: 0.95 }]
    }, makeState({
      activeAgentId: "travel",
      recentTurns: [
        {
          role: "assistant",
          message: "We are still planning the trip.",
          agentId: "travel",
          createdAt: new Date().toISOString()
        }
      ]
    }));

    const result = await service.decideRoute({
      channelId: "wechat",
      userId: "u1",
      text: "顺便看看这家公司",
      externalMessageId: "m-sticky",
      conversationId: "c1"
    });

    expect(result.decision.targetAgentId).toBe("travel");
    expect(result.decision.reason).toBe("active_followup");
  });

  it("keeps an explicit slash-selected agent sticky until the next slash command", async () => {
    const service = makeService({
      topAgentId: "main",
      confidence: 0.95,
      margin: 0.6,
      reasoningTags: ["semantic"],
      alternatives: [{ agentId: "main", score: 0.95 }]
    }, makeState({
      activeAgentId: "travel",
      recentTurns: [
        {
          role: "user",
          message: "/code 帮我看下",
          createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString()
        },
        {
          role: "assistant",
          message: "先看一下。",
          agentId: "coding",
          createdAt: new Date(Date.now() - 90 * 1000).toISOString()
        },
        {
          role: "assistant",
          message: "We are still planning the trip.",
          agentId: "travel",
          createdAt: new Date().toISOString()
        }
      ]
    }));

    const result = await service.decideRoute({
      channelId: "wechat",
      userId: "u1",
      text: "再顺便研究一下这个公司",
      externalMessageId: "m-explicit-sticky",
      conversationId: "c1"
    });

    expect(result.decision.targetAgentId).toBe("coding");
    expect(result.decision.reason).toBe("active_followup");
  });

  it("replaces the sticky agent after a newer slash command", async () => {
    const service = makeService({
      topAgentId: "main",
      confidence: 0.95,
      margin: 0.6,
      reasoningTags: ["semantic"],
      alternatives: [{ agentId: "main", score: 0.95 }]
    }, makeState({
      activeAgentId: "coding",
      recentTurns: [
        {
          role: "user",
          message: "/code 帮我看下",
          createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString()
        },
        {
          role: "assistant",
          message: "先看一下。",
          agentId: "coding",
          createdAt: new Date(Date.now() - 4 * 60 * 1000).toISOString()
        },
        {
          role: "user",
          message: "/travel 帮我规划一下",
          createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString()
        },
        {
          role: "assistant",
          message: "先看行程。",
          agentId: "travel",
          createdAt: new Date(Date.now() - 90 * 1000).toISOString()
        }
      ]
    }));

    const result = await service.decideRoute({
      channelId: "wechat",
      userId: "u1",
      text: "再看看预算",
      externalMessageId: "m-explicit-switch",
      conversationId: "c1"
    });

    expect(result.decision.targetAgentId).toBe("travel");
    expect(result.decision.reason).toBe("active_followup");
  });

  it("stops sticking when the previous turn is too old", async () => {
    const service = makeService({
      topAgentId: "coding",
      confidence: 0.92,
      margin: 0.5,
      reasoningTags: ["semantic"],
      alternatives: [{ agentId: "coding", score: 0.92 }]
    }, makeState({
      activeAgentId: "travel",
      recentTurns: [
        {
          role: "assistant",
          message: "Old travel context.",
          agentId: "travel",
          createdAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()
        }
      ]
    }));

    const result = await service.decideRoute({
      channelId: "wechat",
      userId: "u1",
      text: "Need debugging help for a code review implementation",
      externalMessageId: "m-stale",
      conversationId: "c1"
    });

    expect(result.decision.targetAgentId).toBe("coding");
  });

  it("falls back safely when classifier errors", async () => {
    const service = makeService(new Error("timeout"), makeState({
      activeAgentId: undefined,
      recentTurns: []
    }));

    const result = await service.decideRoute({
      channelId: "wechat",
      userId: "u1",
      text: "random low signal text",
      externalMessageId: "m3",
      conversationId: "c1"
    });

    expect(["fallback_main", "clarify"]).toContain(result.decision.reason);
  });

  it("uses scenario hints to rank travel before calling classifier", async () => {
    const service = makeService({
      topAgentId: "travel",
      confidence: 0.9,
      margin: 0.3,
      scenarioLabel: "travel planning",
      reasoningTags: ["scenario"],
      alternatives: [
        { agentId: "travel", score: 0.9 },
        { agentId: "main", score: 0.4 }
      ]
    }, makeState({
      activeAgentId: undefined,
      recentTurns: []
    }));

    const result = await service.decideRoute({
      channelId: "wechat",
      userId: "u1",
      text: "帮我规划东京周末，预算低一点",
      externalMessageId: "m4",
      conversationId: "c1"
    });

    expect(result.decision.targetAgentId).toBe("travel");
    expect(result.decision.scenarioLabel).toBe("travel planning");
  });

  it("uses configured descriptions when no explicit alias is provided", async () => {
    const service = makeService(null, makeState({
      activeAgentId: undefined,
      recentTurns: []
    }));

    const result = await service.decideRoute({
      channelId: "wechat",
      userId: "u1",
      text: "Need debugging help for a code review implementation",
      externalMessageId: "m5",
      conversationId: "c1"
    });

    expect(result.decision.targetAgentId).toBe("coding");
    expect(result.decision.reason).toBe("keyword_rule");
  });
});
