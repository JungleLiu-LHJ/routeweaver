import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentMonitor } from "../src/server/agent-monitor.js";
import type { AgentProfile } from "../src/domain/types.js";

function makeAgent(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
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
    riskLevel: "medium",
    healthCheck: {
      enabled: true,
      healthUrl: "http://127.0.0.1:8790/health",
      timeoutMs: 1000,
      failureThreshold: 2,
      restartCommand: "hermes --profile finances gateway restart",
      restartTimeoutMs: 5000,
      restartCooldownMs: 60000
    },
    ...overrides
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("AgentMonitor", () => {
  it("restarts an agent after consecutive heartbeat failures", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    vi.stubGlobal("fetch", fetchMock);
    const executeCommand = vi.fn(async () => ({
      ok: true,
      exitCode: 0,
      stdout: "started",
      stderr: ""
    }));

    const monitor = new AgentMonitor({
      agents: [makeAgent()],
      endpointByRef: {
        "hermes-finance": "http://127.0.0.1:8790/hermes-router/message"
      },
      heartbeat: {
        enabled: true,
        intervalMs: 1000
      },
      executeCommand
    });

    monitor.start();
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(1000);

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(executeCommand).toHaveBeenCalledTimes(1);
    const snapshot = monitor.listSnapshots()[0];
    expect(snapshot).toMatchObject({
      agentId: "finance",
      restartCount: 1,
      lastRestartOk: true
    });
    monitor.stop();
  });

  it("supports manual restart through the public API", async () => {
    const executeCommand = vi.fn(async () => ({
      ok: true,
      exitCode: 0,
      stdout: "started",
      stderr: ""
    }));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    const monitor = new AgentMonitor({
      agents: [makeAgent()],
      endpointByRef: {
        "hermes-finance": "http://127.0.0.1:8790/hermes-router/message"
      },
      heartbeat: {
        enabled: false,
        intervalMs: 1000
      },
      executeCommand
    });

    const result = await monitor.restartAgent("finance");

    expect(result.ok).toBe(true);
    expect(executeCommand).toHaveBeenCalledWith("hermes --profile finances gateway restart", 5000);
    expect(result.snapshot?.restartCount).toBe(1);
  });

  it("does not repeatedly restart during the cooldown window", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    vi.stubGlobal("fetch", fetchMock);
    const executeCommand = vi.fn(async () => ({
      ok: true,
      exitCode: 0,
      stdout: "restarted",
      stderr: ""
    }));

    const monitor = new AgentMonitor({
      agents: [makeAgent({
        healthCheck: {
          enabled: true,
          healthUrl: "http://127.0.0.1:8790/health",
          timeoutMs: 1000,
          failureThreshold: 1,
          restartCommand: "hermes --profile finances gateway restart",
          restartTimeoutMs: 5000,
          restartCooldownMs: 60000
        }
      })],
      endpointByRef: {
        "hermes-finance": "http://127.0.0.1:8790/hermes-router/message"
      },
      heartbeat: {
        enabled: true,
        intervalMs: 1000
      },
      executeCommand
    });

    monitor.start();
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(5000);

    expect(executeCommand).toHaveBeenCalledTimes(1);
    monitor.stop();
  });
});
