import { z } from "zod";
import { RESERVED_ALIASES } from "../domain/commands.js";

const backendKindSchema = z.enum(["hermes", "openclaw", "acp", "custom-http"]);
const riskLevelSchema = z.enum(["low", "medium", "high"]);

const classifierSchema = z.object({
  enabled: z.boolean(),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxRecentTurns: z.number().int().positive().optional(),
  minConfidenceDirect: z.number().min(0).max(1).optional(),
  minConfidenceKeepActive: z.number().min(0).max(1).optional(),
  minMarginDirect: z.number().min(0).max(1).optional(),
  clarifyBelow: z.number().min(0).max(1).optional()
}).superRefine((value, ctx) => {
  if (!value.enabled) {
    return;
  }

  for (const field of ["provider", "model", "timeoutMs", "maxRecentTurns", "minConfidenceDirect", "minConfidenceKeepActive", "minMarginDirect", "clarifyBelow"] as const) {
    if (value[field] === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `classifier.${field} is required when classifier.enabled = true`,
        path: [field]
      });
    }
  }
});

const storageSchema = z.object({
  sqlitePath: z.string().min(1).default(".data/hermes-router.sqlite")
});

const securitySchema = z.object({
  allowlist: z.array(z.string().min(1)).default([]),
  internalPushToken: z.string().min(16)
});

const backendsSchema = z.object({
  endpointByRef: z.record(z.string().min(1), z.string().url()).default({})
});

const wechatSchema = z.object({
  bindingTokenTtlSeconds: z.number().int().positive().default(600),
  mode: z.enum(["webhook", "clawbot"]).default("webhook"),
  clawbot: z.object({
    enabled: z.boolean().default(false),
    sessionPath: z.string().min(1).default(".data/clawbot-session.json"),
    pollIntervalMs: z.number().int().positive().default(1000),
    loginTimeoutMs: z.number().int().positive().default(480000),
    longPollTimeoutMs: z.number().int().positive().default(35000),
    botType: z.string().min(1).default("3"),
    botAgent: z.string().min(1).optional()
  }).default({
    enabled: false,
    sessionPath: ".data/clawbot-session.json",
    pollIntervalMs: 1000,
    loginTimeoutMs: 480000,
    longPollTimeoutMs: 35000,
    botType: "3"
  })
});

const agentProfileSchema = z.object({
  agentId: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1),
  backendKind: backendKindSchema,
  backendRef: z.string().min(1).optional(),
  backendUrl: z.string().url().optional(),
  restartUrl: z.string().url().optional(),
  healthUrl: z.string().url().optional(),
  aliases: z.array(z.string().min(1)).default([]),
  capabilityTags: z.array(z.string().min(1)).default([]),
  keywordHints: z.array(z.string().min(1)).default([]),
  scenarioHints: z.array(z.string().min(1)).optional(),
  pushCategories: z.array(z.string().min(1)).default([]),
  enabled: z.boolean(),
  listed: z.boolean(),
  isMain: z.boolean().optional(),
  riskLevel: riskLevelSchema
}).superRefine((value, ctx) => {
  if (!value.backendRef && !value.backendUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "agent must define backendUrl or backendRef",
      path: ["backendRef"]
    });
  }
});

export const routerConfigSchema = z.object({
  storage: storageSchema.default({ sqlitePath: ".data/hermes-router.sqlite" }),
  security: securitySchema,
  backends: backendsSchema.default({ endpointByRef: {} }),
  wechat: wechatSchema.default({
    bindingTokenTtlSeconds: 600,
    mode: "webhook",
    clawbot: {
      enabled: false,
      sessionPath: ".data/clawbot-session.json",
      pollIntervalMs: 1000,
      loginTimeoutMs: 480000,
      longPollTimeoutMs: 35000,
      botType: "3"
    }
  }),
  router: z.object({
    defaultMainAgentId: z.string().min(1),
    stickyAgentWindowMinutes: z.number().int().nonnegative().default(180),
    classifier: classifierSchema
  }),
  agents: z.array(agentProfileSchema)
}).superRefine((value, ctx) => {
  const enabledAgents = value.agents.filter((agent) => agent.enabled);
  const mainAgents = enabledAgents.filter((agent) => agent.isMain);

  if (mainAgents.length !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "exactly one enabled agent must set isMain: true",
      path: ["agents"]
    });
  }

  const aliasOwner = new Map<string, string>();
  for (const agent of enabledAgents) {
    for (const alias of agent.aliases.map((item) => item.toLowerCase())) {
      if (RESERVED_ALIASES.has(alias)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `alias "${alias}" is reserved`,
          path: ["agents"]
        });
      }

      const owner = aliasOwner.get(alias);
      if (owner) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `alias "${alias}" is used by both "${owner}" and "${agent.agentId}"`,
          path: ["agents"]
        });
      } else {
        aliasOwner.set(alias, agent.agentId);
      }
    }
  }

  const mainAgent = enabledAgents.find((agent) => agent.agentId === value.router.defaultMainAgentId);
  if (!mainAgent) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "router.defaultMainAgentId must reference an enabled agent",
      path: ["router", "defaultMainAgentId"]
    });
  }
});

export type RouterConfig = z.infer<typeof routerConfigSchema>;
