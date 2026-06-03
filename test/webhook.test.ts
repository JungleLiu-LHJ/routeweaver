import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createApp } from "../src/server/app.js";
import type { RouterConfig } from "../src/config/schema.js";

function makeConfig(): RouterConfig {
  return {
    storage: { sqlitePath: ":memory:" },
    security: {
      allowlist: ["u1"],
      internalPushToken: "test-internal-push-token"
    },
    backends: {
      endpointByRef: {
        main: "http://backend/main",
        codex: "http://backend/codex",
        finance: "http://backend/finance"
      }
    },
    wechat: {
      bindingTokenTtlSeconds: 600
    },
    router: {
      defaultMainAgentId: "main",
      classifier: {
        enabled: false
      }
    },
    agents: [
      {
        agentId: "main",
        displayName: "Main",
        description: "fallback",
        backendKind: "custom-http",
        backendUrl: "http://backend/main",
        aliases: ["main"],
        capabilityTags: ["general"],
        keywordHints: [],
        pushCategories: ["general"],
        enabled: true,
        listed: true,
        isMain: true,
        riskLevel: "low"
      },
      {
        agentId: "coding",
        displayName: "Coding",
        description: "ACP coding agent for debugging and implementation",
        backendKind: "acp",
        backendUrl: "http://backend/codex/message",
        restartUrl: "http://backend/codex/restart",
        healthUrl: "http://backend/codex/health",
        aliases: ["code"],
        capabilityTags: ["coding"],
        keywordHints: ["bug"],
        pushCategories: [],
        enabled: true,
        listed: true,
        riskLevel: "medium"
      },
      {
        agentId: "finance",
        displayName: "Finance Hermes",
        description: "finance and budget",
        backendKind: "hermes",
        backendUrl: "http://backend/finance",
        restartUrl: "http://backend/finance/restart",
        aliases: ["finance"],
        capabilityTags: ["finance"],
        keywordHints: ["budget"],
        pushCategories: ["finance_alert"],
        enabled: true,
        listed: true,
        riskLevel: "medium"
      }
    ]
  };
}

function wechat(text: string, id: string) {
  return {
    FromUserName: "u1",
    MsgId: id,
    Content: text
  };
}

function wechatImage(id: string) {
  return {
    FromUserName: "u1",
    MsgId: id,
    MsgType: "image",
    PicUrl: "https://example.com/test.jpg",
    MediaId: "media-image-1"
  };
}

function wechatVoice(id: string, recognition = "bug in prod") {
  return {
    FromUserName: "u1",
    MsgId: id,
    MsgType: "voice",
    MediaId: "media-voice-1",
    Format: "amr",
    Recognition: recognition
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("wechat webhook integration", () => {
  it("rejects unbound users before routing", async () => {
    const app = createApp(makeConfig());
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/wechat",
      payload: wechat("/code fix it", "m1")
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ content: expect.stringContaining("绑定") });
    await app.close();
  });

  it("routes a bound explicit alias to the backend and stores task refs", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      content: "working on it",
      taskRef: "task-1",
      taskStatus: "running"
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp(makeConfig());
    await app.inject({ method: "POST", url: "/admin/bindings/wechat", payload: { userId: "u1" } });

    const routed = await app.inject({
      method: "POST",
      url: "/webhooks/wechat",
      payload: wechat("/code fix it", "m2")
    });
    expect(routed.json()).toMatchObject({ content: "working on it" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const tasks = await app.inject({
      method: "POST",
      url: "/webhooks/wechat",
      payload: wechat("/tasks", "m3")
    });
    expect(tasks.json().content).toContain("task-1");
    await app.close();
  });

  it("submits Hermes routes asynchronously and updates tasks by backend task ref", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      taskRef: "hermes-task-1",
      taskStatus: "queued"
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp(makeConfig());
    await app.inject({ method: "POST", url: "/admin/bindings/wechat", payload: { userId: "u1" } });

    const submitted = await app.inject({
      method: "POST",
      url: "/webhooks/wechat",
      payload: wechat("/finance review budget", "m-hermes-1")
    });
    expect(submitted.json()).toMatchObject({ content: "任务已提交：hermes-task-1" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://backend/finance");
    expect(JSON.parse(String(init.body))).toMatchObject({
      responseMode: "async",
      agentId: "finance",
      message: "review budget",
      sourceChannel: "wechat"
    });

    const queued = await app.inject({
      method: "POST",
      url: "/webhooks/wechat",
      payload: wechat("/tasks", "m-hermes-2")
    });
    expect(queued.json().content).toContain("finance queued hermes-task-1");

    const updated = await app.inject({
      method: "POST",
      url: "/internal/tasks/action",
      headers: { authorization: "Bearer test-internal-push-token" },
      payload: { taskId: "hermes-task-1", status: "completed" }
    });
    expect(updated.json()).toMatchObject({ ok: true });

    const completed = await app.inject({
      method: "POST",
      url: "/webhooks/wechat",
      payload: wechat("/tasks", "m-hermes-3")
    });
    expect(completed.json().content).toContain("finance completed hermes-task-1");
    await app.close();
  });

  it("restarts a configured agent through the admin endpoint", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/restart")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ content: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp(makeConfig());

    const restarted = await app.inject({
      method: "POST",
      url: "/admin/agents/coding/restart",
      headers: { authorization: "Bearer test-internal-push-token" }
    });

    expect(restarted.statusCode).toBe(200);
    expect(restarted.json()).toMatchObject({ ok: true, agentId: "coding" });
    expect(fetchMock).toHaveBeenCalledWith("http://backend/codex/restart", { method: "POST" });
    await app.close();
  });

  it("forwards image messages to the active agent with media metadata", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      content: "image received"
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp(makeConfig());
    await app.inject({ method: "POST", url: "/admin/bindings/wechat", payload: { userId: "u1" } });

    await app.inject({
      method: "POST",
      url: "/webhooks/wechat",
      payload: wechat("/code fix it", "m-image-setup")
    });

    const routed = await app.inject({
      method: "POST",
      url: "/webhooks/wechat",
      payload: wechatImage("m-image-1")
    });

    expect(routed.json()).toMatchObject({ content: "image received" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, imageInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const imageBody = JSON.parse(String(imageInit.body));
    expect(imageBody).toMatchObject({
      agentId: "coding",
      message: "[image]",
      inputType: "image",
      media: {
        mediaId: "media-image-1",
        url: "https://example.com/test.jpg"
      }
    });

    await app.close();
  });

  it("forwards voice messages with recognition text and media metadata", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      content: "voice received"
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp(makeConfig());
    await app.inject({ method: "POST", url: "/admin/bindings/wechat", payload: { userId: "u1" } });

    await app.inject({
      method: "POST",
      url: "/webhooks/wechat",
      payload: wechat("/code fix it", "m-voice-setup")
    });

    const routed = await app.inject({
      method: "POST",
      url: "/webhooks/wechat",
      payload: wechatVoice("m-voice-1")
    });

    expect(routed.json()).toMatchObject({ content: "voice received" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, voiceInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const voiceBody = JSON.parse(String(voiceInit.body));
    expect(voiceBody).toMatchObject({
      agentId: "coding",
      message: "bug in prod",
      inputType: "voice",
      media: {
        mediaId: "media-voice-1",
        format: "amr",
        recognitionText: "bug in prod"
      }
    });

    await app.close();
  });

  it("binds from a WeChat QR scan event key", async () => {
    const app = createApp(makeConfig());
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/admin/binding-token",
      payload: { routerUserId: "me" }
    });
    const token = tokenResponse.json().binding.token;

    const scan = await app.inject({
      method: "POST",
      url: "/webhooks/wechat",
      payload: {
        FromUserName: "u1",
        Event: "SCAN",
        EventKey: token,
        CreateTime: 123
      }
    });

    expect(scan.json()).toMatchObject({ content: "绑定成功。" });
    await app.close();
  });

  it("binds from a subscribe event with qrscene prefix", async () => {
    const app = createApp(makeConfig());
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/admin/binding-token",
      payload: { routerUserId: "me" }
    });
    const token = tokenResponse.json().binding.token;

    const scan = await app.inject({
      method: "POST",
      url: "/webhooks/wechat",
      payload: {
        FromUserName: "u1",
        Event: "subscribe",
        EventKey: `qrscene_${token}`,
        CreateTime: 124
      }
    });

    expect(scan.json()).toMatchObject({ content: "绑定成功。" });
    await app.close();
  });

  it("accepts trusted ClawBot forwarded messages without router binding", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      content: "clawbot routed"
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp(makeConfig());

    const routed = await app.inject({
      method: "POST",
      url: "/webhooks/clawbot",
      headers: { authorization: "Bearer test-internal-push-token" },
      payload: {
        openid: "wx-user-1",
        messageId: "clawbot-m1",
        text: "/code fix it"
      }
    });

    expect(routed.json()).toMatchObject({ content: "clawbot routed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("rejects untrusted ClawBot forwards", async () => {
    const app = createApp(makeConfig());
    const denied = await app.inject({
      method: "POST",
      url: "/webhooks/clawbot",
      payload: {
        openid: "wx-user-1",
        messageId: "clawbot-m2",
        text: "/code fix it"
      }
    });

    expect(denied.statusCode).toBe(401);
    await app.close();
  });

  it("accepts internal push only with token and respects bindings", async () => {
    const app = createApp(makeConfig());
    await app.inject({ method: "POST", url: "/admin/bindings/wechat", payload: { userId: "u1" } });

    const denied = await app.inject({
      method: "POST",
      url: "/internal/push",
      payload: { userId: "u1", category: "general", payload: { content: "hello" } }
    });
    expect(denied.statusCode).toBe(401);

    const accepted = await app.inject({
      method: "POST",
      url: "/internal/push",
      headers: { authorization: "Bearer test-internal-push-token" },
      payload: { userId: "u1", category: "general", dedupeKey: "push-1", payload: { content: "hello" } }
    });
    expect(accepted.json()).toMatchObject({ accepted: true });

    const duplicate = await app.inject({
      method: "POST",
      url: "/internal/push",
      headers: { authorization: "Bearer test-internal-push-token" },
      payload: { userId: "u1", category: "general", dedupeKey: "push-1", payload: { content: "hello again" } }
    });
    expect(duplicate.json()).toMatchObject({ accepted: false, reason: "duplicate" });
    await app.close();
  });

  it("delivers internal push through ClawBot when clawbot mode is enabled", async () => {
    const sessionPath = path.join(os.tmpdir(), `hermes-router-clawbot-test-${Date.now()}.json`);
    await fs.writeFile(sessionPath, JSON.stringify({
      version: 1,
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "test-bot-token",
      contextTokens: {}
    }), "utf-8");

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    const config = makeConfig();
    config.wechat = {
      bindingTokenTtlSeconds: 600,
      mode: "clawbot",
      clawbot: {
        enabled: true,
        sessionPath,
        pollIntervalMs: 1000,
        loginTimeoutMs: 480000,
        longPollTimeoutMs: 35000,
        botType: "3"
      }
    };

    const app = createApp(config);
    await app.inject({ method: "POST", url: "/admin/bindings/wechat", payload: { userId: "u1" } });

    const accepted = await app.inject({
      method: "POST",
      url: "/internal/push",
      headers: { authorization: "Bearer test-internal-push-token" },
      payload: { userId: "u1", category: "general", payload: { content: "hello from cron" } }
    });

    expect(accepted.json()).toMatchObject({ accepted: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/ilink/bot/sendmessage");

    await app.close();
    await fs.rm(sessionPath, { force: true });
  });

  it("pauses backend confirmation until the user confirms", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        content: "needs approval",
        requiresConfirmation: true,
        confirmationText: "确认执行高风险操作？",
        confirmationRef: "confirm-1"
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        content: "done"
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp(makeConfig());
    await app.inject({ method: "POST", url: "/admin/bindings/wechat", payload: { userId: "u1" } });

    const pending = await app.inject({
      method: "POST",
      url: "/webhooks/wechat",
      payload: wechat("/code deploy", "m4")
    });
    expect(pending.json().content).toContain("确认执行");

    const blocked = await app.inject({
      method: "POST",
      url: "/webhooks/wechat",
      payload: wechat("先等等", "m5")
    });
    expect(blocked.json().content).toContain("待确认操作");

    const confirmed = await app.inject({
      method: "POST",
      url: "/webhooks/wechat",
      payload: wechat("确认", "m6")
    });
    expect(confirmed.json()).toMatchObject({ content: "done" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await app.close();
  });
});
