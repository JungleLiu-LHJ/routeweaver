import { describe, expect, it } from "vitest";
import { routerConfigSchema } from "../src/config/schema.js";

const baseConfig = {
  storage: {
    sqlitePath: ":memory:"
  },
  security: {
    allowlist: [],
    internalPushToken: "test-internal-push-token"
  },
  backends: {
    endpointByRef: {}
  },
  wechat: {
    bindingTokenTtlSeconds: 600
  },
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
      aliases: ["code"],
      capabilityTags: ["coding"],
      keywordHints: ["bug"],
      pushCategories: [],
      enabled: true,
      listed: true,
      riskLevel: "medium"
    }
  ]
} as const;

describe("routerConfigSchema", () => {
  it("rejects duplicate aliases", () => {
    expect(() =>
      routerConfigSchema.parse({
        ...baseConfig,
        agents: [
          ...baseConfig.agents,
          {
            ...baseConfig.agents[1],
            agentId: "coding-2",
            aliases: ["code"]
          }
        ]
      })
    ).toThrow(/used by both/i);
  });

  it("rejects reserved aliases", () => {
    expect(() =>
      routerConfigSchema.parse({
        ...baseConfig,
        agents: [
          {
            ...baseConfig.agents[0],
            aliases: ["all"]
          },
          baseConfig.agents[1]
        ]
      })
    ).toThrow(/reserved/i);
  });

  it("requires an internal push token", () => {
    const { security, ...withoutSecurity } = baseConfig;
    expect(() => routerConfigSchema.parse(withoutSecurity)).toThrow(/security/i);
    expect(security.internalPushToken).toBeTruthy();
  });

  it("accepts clawbot config", () => {
    const parsed = routerConfigSchema.parse({
      ...baseConfig,
      wechat: {
        bindingTokenTtlSeconds: 600,
        mode: "clawbot",
        clawbot: {
          enabled: true,
          sessionPath: ".data/clawbot-session.json",
          pollIntervalMs: 1000,
          loginTimeoutMs: 480000,
          longPollTimeoutMs: 35000,
          botType: "3",
          botAgent: "HermesRouter/0.1.0"
        }
      }
    });

    expect(parsed.wechat.mode).toBe("clawbot");
    expect(parsed.wechat.clawbot.enabled).toBe(true);
  });

  it("accepts sticky agent window config", () => {
    const parsed = routerConfigSchema.parse(baseConfig);
    expect(parsed.router.stickyAgentWindowMinutes).toBe(180);
  });

  it("accepts inline backend urls without backendRef", () => {
    const parsed = routerConfigSchema.parse({
      ...baseConfig,
      agents: [
        {
          ...baseConfig.agents[0],
          backendRef: undefined,
          backendUrl: "http://127.0.0.1:8788/hermes-router/message",
          restartUrl: "http://127.0.0.1:8788/hermes-router/restart",
          healthUrl: "http://127.0.0.1:8788/hermes-router/health"
        },
        baseConfig.agents[1]
      ]
    });

    expect(parsed.agents[0]?.backendUrl).toBe("http://127.0.0.1:8788/hermes-router/message");
    expect(parsed.agents[0]?.backendRef).toBeUndefined();
  });
});
