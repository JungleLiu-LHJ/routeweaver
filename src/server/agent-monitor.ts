import { spawn } from "node:child_process";
import type { AgentProfile } from "../domain/types.js";

interface HeartbeatConfig {
  enabled: boolean;
  intervalMs: number;
}

interface MonitorConfig {
  agents: AgentProfile[];
  endpointByRef: Record<string, string>;
  heartbeat: HeartbeatConfig;
  logger?: {
    info(payload: unknown, message?: string): void;
    warn(payload: unknown, message?: string): void;
    error(payload: unknown, message?: string): void;
  };
  writeAudit?: (eventType: string, payload: Record<string, unknown>) => Promise<void>;
  executeCommand?: (command: string, timeoutMs: number) => Promise<{ ok: boolean; exitCode: number | null; stdout: string; stderr: string }>;
}

export interface AgentHealthSnapshot {
  agentId: string;
  displayName: string;
  enabled: boolean;
  monitored: boolean;
  healthUrl?: string;
  healthy: boolean | null;
  consecutiveFailures: number;
  lastCheckAt?: string;
  lastHealthyAt?: string;
  lastError?: string;
  restartCommand?: string;
  restartCount: number;
  lastRestartAt?: string;
  lastRestartOk?: boolean;
  lastRestartOutput?: string;
}

interface AgentMonitorState extends AgentHealthSnapshot {
  timeoutMs?: number;
  failureThreshold?: number;
  restartTimeoutMs?: number;
  restartCooldownMs?: number;
  restartInFlight: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function truncate(value: string, max = 500): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function baseEndpoint(agent: AgentProfile, endpointByRef: Record<string, string>): string | undefined {
  return agent.backendUrl ?? (agent.backendRef ? endpointByRef[agent.backendRef] : undefined);
}

function deriveHealthUrl(agent: AgentProfile, endpointByRef: Record<string, string>): string | undefined {
  const configured = agent.healthCheck?.healthUrl ?? agent.healthUrl;
  if (configured) {
    return configured;
  }

  const endpoint = baseEndpoint(agent, endpointByRef);
  if (!endpoint) {
    return undefined;
  }

  try {
    const url = new URL(endpoint);
    if (url.pathname.endsWith("/hermes-router/message")) {
      url.pathname = url.pathname.replace(/\/hermes-router\/message$/, "/health");
      return url.toString();
    }
    if (url.pathname.endsWith("/message")) {
      url.pathname = url.pathname.replace(/\/message$/, "/health");
      return url.toString();
    }
  } catch {
    return undefined;
  }

  return `${endpoint.replace(/\/$/, "")}/health`;
}

async function defaultExecuteCommand(command: string, timeoutMs: number): Promise<{ ok: boolean; exitCode: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn("/bin/zsh", ["-lc", command], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        child.kill("SIGTERM");
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });
    child.on("error", (error) => {
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: null,
        stdout: stdout.trim(),
        stderr: error.message
      });
    });
  });
}

export class AgentMonitor {
  private readonly states = new Map<string, AgentMonitorState>();
  private readonly executeCommand: NonNullable<MonitorConfig["executeCommand"]>;
  private timer?: NodeJS.Timeout;
  private tickInFlight = false;

  constructor(private readonly config: MonitorConfig) {
    this.executeCommand = config.executeCommand ?? defaultExecuteCommand;
    for (const agent of config.agents) {
      const monitored = Boolean(agent.enabled && agent.healthCheck?.enabled);
      this.states.set(agent.agentId, {
        agentId: agent.agentId,
        displayName: agent.displayName,
        enabled: agent.enabled,
        monitored,
        healthUrl: monitored ? deriveHealthUrl(agent, config.endpointByRef) : undefined,
        healthy: null,
        consecutiveFailures: 0,
        restartCommand: agent.healthCheck?.restartCommand,
        restartCount: 0,
        timeoutMs: agent.healthCheck?.timeoutMs,
        failureThreshold: agent.healthCheck?.failureThreshold,
        restartTimeoutMs: agent.healthCheck?.restartTimeoutMs,
        restartCooldownMs: agent.healthCheck?.restartCooldownMs,
        restartInFlight: false
      });
    }
  }

  start(): void {
    if (!this.config.heartbeat?.enabled || this.timer) {
      return;
    }
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.heartbeat.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  listSnapshots(): AgentHealthSnapshot[] {
    return [...this.states.values()].map(({ timeoutMs: _timeoutMs, failureThreshold: _failureThreshold, restartTimeoutMs: _restartTimeoutMs, restartCooldownMs: _restartCooldownMs, restartInFlight: _restartInFlight, ...snapshot }) => snapshot);
  }

  async restartAgent(agentId: string, reason = "manual"): Promise<{ ok: boolean; reason?: string; snapshot?: AgentHealthSnapshot }> {
    const state = this.states.get(agentId);
    if (!state) {
      return { ok: false, reason: "unknown agent" };
    }
    if (!state.monitored) {
      return { ok: false, reason: "agent is not monitored", snapshot: this.snapshotFor(state) };
    }
    if (!state.restartCommand) {
      return { ok: false, reason: "restartCommand is not configured", snapshot: this.snapshotFor(state) };
    }
    await this.runRestart(state, reason);
    return { ok: Boolean(state.lastRestartOk), snapshot: this.snapshotFor(state) };
  }

  private snapshotFor(state: AgentMonitorState): AgentHealthSnapshot {
    const { timeoutMs: _timeoutMs, failureThreshold: _failureThreshold, restartTimeoutMs: _restartTimeoutMs, restartCooldownMs: _restartCooldownMs, restartInFlight: _restartInFlight, ...snapshot } = state;
    return snapshot;
  }

  private async tick(): Promise<void> {
    if (this.tickInFlight) {
      return;
    }
    this.tickInFlight = true;
    try {
      for (const state of this.states.values()) {
        if (!state.monitored) {
          continue;
        }
        await this.checkAgent(state);
      }
    } finally {
      this.tickInFlight = false;
    }
  }

  private async checkAgent(state: AgentMonitorState): Promise<void> {
    state.lastCheckAt = nowIso();
    if (!state.healthUrl) {
      state.healthy = false;
      state.consecutiveFailures += 1;
      state.lastError = "healthUrl is not configured and could not be derived";
      await this.maybeRestart(state, "missing health url");
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), state.timeoutMs ?? 3000);

    try {
      const response = await fetch(state.healthUrl, {
        method: "GET",
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`health HTTP ${response.status}`);
      }
      state.healthy = true;
      state.consecutiveFailures = 0;
      state.lastHealthyAt = nowIso();
      state.lastError = undefined;
    } catch (error) {
      state.healthy = false;
      state.consecutiveFailures += 1;
      state.lastError = error instanceof Error ? error.message : String(error);
      this.config.logger?.warn({
        agentId: state.agentId,
        error: state.lastError,
        consecutiveFailures: state.consecutiveFailures
      }, "agent heartbeat failed");
      await this.config.writeAudit?.("agent.health.failure", {
        agentId: state.agentId,
        error: state.lastError,
        consecutiveFailures: state.consecutiveFailures
      });
      await this.maybeRestart(state, "health check failed");
    } finally {
      clearTimeout(timer);
    }
  }

  private async maybeRestart(state: AgentMonitorState, reason: string): Promise<void> {
    const threshold = state.failureThreshold ?? 2;
    if (state.consecutiveFailures < threshold || !state.restartCommand || state.restartInFlight) {
      return;
    }
    if (state.lastRestartAt) {
      const cooldownMs = state.restartCooldownMs ?? 60000;
      const elapsedMs = Date.now() - Date.parse(state.lastRestartAt);
      if (elapsedMs >= 0 && elapsedMs < cooldownMs) {
        return;
      }
    }
    await this.runRestart(state, reason);
  }

  private async runRestart(state: AgentMonitorState, reason: string): Promise<void> {
    const command = state.restartCommand;
    if (!command) {
      return;
    }
    state.restartInFlight = true;
    state.lastRestartAt = nowIso();
    try {
      const result = await this.executeCommand(command, state.restartTimeoutMs ?? 15000);
      state.restartCount += 1;
      state.lastRestartOk = result.ok;
      state.lastRestartOutput = truncate([result.stdout, result.stderr].filter(Boolean).join("\n"));
      if (result.ok) {
        state.lastError = "restart command completed; waiting for next heartbeat verification";
        this.config.logger?.info({ agentId: state.agentId, reason, command }, "agent restart succeeded");
      } else {
        this.config.logger?.error({
          agentId: state.agentId,
          reason,
          command,
          exitCode: result.exitCode,
          output: state.lastRestartOutput
        }, "agent restart failed");
      }
      await this.config.writeAudit?.("agent.restart", {
        agentId: state.agentId,
        reason,
        command,
        ok: result.ok,
        exitCode: result.exitCode,
        output: state.lastRestartOutput
      });
    } finally {
      state.restartInFlight = false;
    }
  }
}
