import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClawBotClient } from "../src/channels/clawbot/client.js";

function tempSessionPath(name: string): string {
  return path.join(os.tmpdir(), `hermes-router-${name}-${Date.now()}.json`);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ClawBotClient", () => {
  it("starts QR login and saves confirmed session", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        qrcode: "qr-1",
        qrcode_img_content: "https://example.com/qr-1"
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: "confirmed",
        bot_token: "bot-token-1",
        ilink_bot_id: "bot@im.bot",
        ilink_user_id: "user@im.wechat",
        baseurl: "https://redirect.example.com"
      }), { status: 200 }));

    const client = new ClawBotClient({
      sessionPath: tempSessionPath("login"),
      fetchImpl: fetchMock
    });

    const started = await client.startLogin(true);
    expect(started.qrCodeUrl).toBe("https://example.com/qr-1");

    const result = await client.waitForLogin({ sessionKey: started.sessionKey, timeoutMs: 10 });
    expect(result.connected).toBe(true);

    const session = await client.loadSession();
    expect(session).toMatchObject({
      accountId: "bot@im.bot",
      token: "bot-token-1",
      userId: "user@im.wechat",
      baseUrl: "https://redirect.example.com"
    });
  });

  it("polls inbox and persists context tokens", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ret: 0,
        get_updates_buf: "buf-2",
        msgs: [
          {
            message_id: 101,
            from_user_id: "wx-user-1",
            to_user_id: "bot@im.bot",
            context_token: "ctx-1",
            item_list: [
              { type: 1, text_item: { text: "你好" } }
            ]
          }
        ]
      }), { status: 200 }));

    const client = new ClawBotClient({
      sessionPath: tempSessionPath("poll"),
      fetchImpl: fetchMock
    });
    await client.saveSession({
      accountId: "bot@im.bot",
      token: "bot-token-2",
      baseUrl: "https://ilinkai.weixin.qq.com"
    });

    const events: string[] = [];
    await client.pollInboxOnce(async (event) => {
      events.push(`${event.fromUserId}:${event.text}`);
    });

    expect(events).toEqual(["wx-user-1:你好"]);
    const session = await client.loadSession();
    expect(session?.getUpdatesBuf).toBe("buf-2");
    expect(session?.contextTokens["wx-user-1"]).toBe("ctx-1");
  });

  it("sends text with stored context token", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const client = new ClawBotClient({
      sessionPath: tempSessionPath("send"),
      fetchImpl: fetchMock
    });
    await client.saveSession({
      accountId: "bot@im.bot",
      token: "bot-token-3",
      baseUrl: "https://ilinkai.weixin.qq.com",
      contextTokens: {
        "wx-user-2": "ctx-2"
      }
    });

    await client.sendText({
      toUserId: "wx-user-2",
      text: "hello"
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body)) as { msg: { context_token?: string; item_list?: Array<{ text_item?: { text?: string } }> } };
    expect(body.msg.context_token).toBe("ctx-2");
    expect(body.msg.item_list?.[0]?.text_item?.text).toBe("hello");
  });

  it("fetches typing ticket once and reuses it for sendTyping", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ret: 0,
        typing_ticket: "ticket-1"
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const client = new ClawBotClient({
      sessionPath: tempSessionPath("typing"),
      fetchImpl: fetchMock
    });
    await client.saveSession({
      accountId: "bot@im.bot",
      token: "bot-token-4",
      baseUrl: "https://ilinkai.weixin.qq.com",
      contextTokens: {
        "wx-user-3": "ctx-3"
      }
    });

    await client.sendTyping({ toUserId: "wx-user-3", status: "start" });
    await client.sendTyping({ toUserId: "wx-user-3", status: "stop" });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("ilink/bot/getconfig");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("ilink/bot/sendtyping");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("ilink/bot/sendtyping");

    const firstTypingBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      ilink_user_id?: string;
      typing_ticket?: string;
      status?: number;
    };
    const secondTypingBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as {
      status?: number;
    };
    expect(firstTypingBody.ilink_user_id).toBe("wx-user-3");
    expect(firstTypingBody.typing_ticket).toBe("ticket-1");
    expect(firstTypingBody.status).toBe(1);
    expect(secondTypingBody.status).toBe(2);
  });
});
