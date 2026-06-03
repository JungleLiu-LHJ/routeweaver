import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SQLiteRouterRepository } from "../src/store/repositories.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("SQLiteRouterRepository", () => {
  it("persists conversations, bindings, tasks, preferences, and dedupe across restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hermes-router-"));
    dirs.push(dir);
    const dbPath = join(dir, "router.sqlite");

    const first = new SQLiteRouterRepository(dbPath);
    await first.bindChannel("wechat", "u1");
    await first.saveUserTurn({
      channelId: "wechat",
      userId: "u1",
      text: "hello",
      externalMessageId: "m1",
      conversationId: "wechat:u1"
    });
    await first.saveAssistantTurn("wechat:u1", "main", "hi", "main");
    await first.setPushMuted("u1", "general", true);
    await first.saveTask({
      conversationId: "wechat:u1",
      agentId: "main",
      backendKind: "custom-http",
      backendTaskRef: "backend-task-1",
      status: "running"
    });
    expect(await first.isDuplicate("m1", "wechat:u1")).toBe(false);
    first.close();

    const second = new SQLiteRouterRepository(dbPath);
    const state = await second.loadConversationState({
      channelId: "wechat",
      userId: "u1",
      text: "ignored",
      externalMessageId: "m2",
      conversationId: "wechat:u1"
    });
    expect(state.activeAgentId).toBe("main");
    expect(state.recentTurns.map((turn) => turn.message)).toEqual(["hello", "hi"]);
    expect(await second.findBinding("wechat", "u1")).toMatchObject({ status: "bound" });
    expect(await second.getPushMuted("u1", "general")).toBe(true);
    expect(await second.listTasks("wechat:u1")).toHaveLength(1);
    expect(await second.isDuplicate("m1", "wechat:u1")).toBe(true);
    second.close();
  });
});
