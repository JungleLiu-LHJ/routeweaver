import type { BackendAdapter } from "../backends/base.js";
import type { TaskRef } from "../domain/types.js";
import type { SQLiteRouterRepository } from "../store/repositories.js";

export class TaskService {
  constructor(
    private readonly repository: SQLiteRouterRepository,
    private readonly backendByAgentId: Map<string, BackendAdapter>
  ) {}

  async list(conversationId: string): Promise<TaskRef[]> {
    return this.repository.listTasks(conversationId);
  }

  async stop(taskId: string, tasks: TaskRef[]): Promise<{ ok: boolean; reason?: string }> {
    const task = tasks.find((item) => item.id === taskId || item.backendTaskRef === taskId);
    if (!task) {
      return { ok: false, reason: "task not found" };
    }
    const backend = this.backendByAgentId.get(task.agentId);
    const stopped = await backend?.stopTask?.(task.backendTaskRef);
    if (stopped === false) {
      return { ok: false, reason: "backend refused stop" };
    }
    await this.repository.updateTaskStatus(task.id, "cancelled");
    return { ok: true };
  }

  async update(taskId: string, status: TaskRef["status"]): Promise<{ ok: boolean }> {
    return { ok: await this.repository.updateTaskStatus(taskId, status) };
  }
}
