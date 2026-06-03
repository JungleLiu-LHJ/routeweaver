import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const DEFAULT_API_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_BOT_AGENT = "HermesRouter/0.1.0";
const DEFAULT_BOT_TYPE = "3";
const DEFAULT_LOGIN_TIMEOUT_MS = 480_000;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MAX_QR_REFRESH_COUNT = 3;

const require = createRequire(import.meta.url);

export interface ClawBotClientOptions {
  sessionPath: string;
  baseUrl?: string;
  loginBaseUrl?: string;
  botType?: string;
  botAgent?: string;
  loginTimeoutMs?: number;
  longPollTimeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ClawBotSession {
  version: 1;
  accountId?: string;
  token?: string;
  baseUrl: string;
  userId?: string;
  savedAt?: string;
  getUpdatesBuf?: string;
  contextTokens: Record<string, string>;
  typingTickets: Record<string, string>;
}

export interface ClawBotLoginStartResult {
  sessionKey: string;
  qrCode: string;
  qrCodeUrl: string;
  message: string;
}

export interface ClawBotLoginResult {
  connected: boolean;
  alreadyConnected?: boolean;
  accountId?: string;
  userId?: string;
  token?: string;
  baseUrl?: string;
  message: string;
}

export interface ClawBotInboundEvent {
  accountId: string;
  fromUserId: string;
  toUserId?: string;
  messageId: string;
  text: string;
  contextToken?: string;
  raw: WeixinMessage;
}

export interface StartReceiveLoopOptions {
  signal?: AbortSignal;
  onMessage: (event: ClawBotInboundEvent) => Promise<void> | void;
  onError?: (error: unknown) => Promise<void> | void;
}

interface ActiveLogin {
  sessionKey: string;
  qrCode: string;
  qrCodeUrl: string;
  startedAt: number;
  currentBaseUrl: string;
  pendingVerifyCode?: string;
}

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface QRStatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired" | "scaned_but_redirect" | "need_verifycode" | "verify_code_blocked" | "binded_redirect";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

interface GetConfigResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  typing_ticket?: string;
}

interface SendMessageResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

interface WeixinTextItem {
  text?: string;
}

interface WeixinMessageItem {
  type?: number;
  msg_id?: string;
  text_item?: WeixinTextItem;
}

interface WeixinMessage {
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  item_list?: WeixinMessageItem[];
  context_token?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function loadOfficialVersion(): string {
  try {
    const packageJsonPath = require.resolve("@tencent-weixin/openclaw-weixin/package.json");
    const raw = require(packageJsonPath) as { version?: string };
    return raw.version ?? "2.4.3";
  } catch {
    return "2.4.3";
  }
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function normalizeText(message: WeixinMessage): string {
  return (message.item_list ?? [])
    .map((item) => item.text_item?.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export class ClawBotClient {
  private readonly fetchImpl: typeof fetch;
  private readonly activeLogins = new Map<string, ActiveLogin>();
  private readonly loginBaseUrl: string;
  private readonly botType: string;
  private readonly botAgent: string;
  private readonly loginTimeoutMs: number;
  private readonly sessionPath: string;
  private nextLongPollTimeoutMs: number;
  private readonly apiVersion = loadOfficialVersion();
  private readonly clientVersion = buildClientVersion(this.apiVersion);

  constructor(private readonly options: ClawBotClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sessionPath = options.sessionPath;
    this.loginBaseUrl = options.loginBaseUrl ?? DEFAULT_API_BASE_URL;
    this.botType = options.botType ?? DEFAULT_BOT_TYPE;
    this.botAgent = options.botAgent ?? DEFAULT_BOT_AGENT;
    this.loginTimeoutMs = options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
    this.nextLongPollTimeoutMs = options.longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  }

  async loadSession(): Promise<ClawBotSession | null> {
    try {
      const raw = await fs.readFile(this.sessionPath, "utf-8");
      const parsed = JSON.parse(raw) as ClawBotSession;
      return {
        version: 1,
        baseUrl: parsed.baseUrl ?? this.options.baseUrl ?? DEFAULT_API_BASE_URL,
        contextTokens: parsed.contextTokens ?? {},
        typingTickets: parsed.typingTickets ?? {},
        accountId: parsed.accountId,
        token: parsed.token,
        userId: parsed.userId,
        savedAt: parsed.savedAt,
        getUpdatesBuf: parsed.getUpdatesBuf
      };
    } catch {
      return null;
    }
  }

  async saveSession(update: Partial<ClawBotSession>): Promise<ClawBotSession> {
    const current = (await this.loadSession()) ?? {
      version: 1 as const,
      baseUrl: this.options.baseUrl ?? DEFAULT_API_BASE_URL,
      contextTokens: {},
      typingTickets: {}
    };
    const next: ClawBotSession = {
      ...current,
      ...update,
      version: 1,
      baseUrl: update.baseUrl ?? current.baseUrl ?? this.options.baseUrl ?? DEFAULT_API_BASE_URL,
      contextTokens: {
        ...current.contextTokens,
        ...(update.contextTokens ?? {})
      },
      typingTickets: {
        ...current.typingTickets,
        ...(update.typingTickets ?? {})
      },
      savedAt: new Date().toISOString()
    };
    await fs.mkdir(path.dirname(this.sessionPath), { recursive: true });
    await fs.writeFile(this.sessionPath, JSON.stringify(next, null, 2), { encoding: "utf-8", mode: 0o600 });
    return next;
  }

  async clearSession(): Promise<void> {
    await fs.rm(this.sessionPath, { force: true });
  }

  async startLogin(force = false): Promise<ClawBotLoginStartResult> {
    const sessionKey = crypto.randomUUID();
    const existing = this.activeLogins.get(sessionKey);
    if (existing && !force) {
      return {
        sessionKey,
        qrCode: existing.qrCode,
        qrCodeUrl: existing.qrCodeUrl,
        message: "二维码已生成。"
      };
    }

    const session = await this.loadSession();
    const response = await this.postJson<QRCodeResponse>({
      baseUrl: this.loginBaseUrl,
      endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(this.botType)}`,
      body: {
        local_token_list: session?.token ? [session.token] : []
      }
    });

    this.activeLogins.set(sessionKey, {
      sessionKey,
      qrCode: response.qrcode,
      qrCodeUrl: response.qrcode_img_content,
      startedAt: Date.now(),
      currentBaseUrl: this.loginBaseUrl
    });

    return {
      sessionKey,
      qrCode: response.qrcode,
      qrCodeUrl: response.qrcode_img_content,
      message: "请使用微信扫码登录。"
    };
  }

  async renderQrToTerminal(qrCodeUrl: string): Promise<void> {
    try {
      const qr = await import("qrcode-terminal");
      (qr.default ?? qr).generate(qrCodeUrl, { small: true });
    } catch {
      process.stdout.write(`${qrCodeUrl}\n`);
    }
  }

  async waitForLogin(params: {
    sessionKey: string;
    timeoutMs?: number;
    onVerificationCode?: () => Promise<string> | string;
  }): Promise<ClawBotLoginResult> {
    const active = this.activeLogins.get(params.sessionKey);
    if (!active) {
      return { connected: false, message: "没有进行中的扫码会话。" };
    }

    const deadline = Date.now() + Math.max(params.timeoutMs ?? this.loginTimeoutMs, 1_000);
    let refreshCount = 0;

    while (Date.now() < deadline) {
      const status = await this.pollQrStatus(active);
      switch (status.status) {
        case "wait":
        case "scaned":
          break;
        case "need_verifycode": {
          if (!params.onVerificationCode) {
            return { connected: false, message: "扫码后需要在终端输入校验码。" };
          }
          active.pendingVerifyCode = String(await params.onVerificationCode()).trim();
          continue;
        }
        case "verify_code_blocked":
        case "expired": {
          refreshCount += 1;
          if (refreshCount > MAX_QR_REFRESH_COUNT) {
            this.activeLogins.delete(params.sessionKey);
            return { connected: false, message: "二维码已失效，请重新扫码。" };
          }
          const refreshed = await this.postJson<QRCodeResponse>({
            baseUrl: this.loginBaseUrl,
            endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(this.botType)}`,
            body: { local_token_list: [] }
          });
          active.qrCode = refreshed.qrcode;
          active.qrCodeUrl = refreshed.qrcode_img_content;
          active.startedAt = Date.now();
          active.currentBaseUrl = this.loginBaseUrl;
          active.pendingVerifyCode = undefined;
          continue;
        }
        case "scaned_but_redirect":
          if (status.redirect_host) {
            active.currentBaseUrl = `https://${status.redirect_host}`;
          }
          break;
        case "binded_redirect":
          this.activeLogins.delete(params.sessionKey);
          return {
            connected: false,
            alreadyConnected: true,
            message: "该微信已经绑定过当前机器人。"
          };
        case "confirmed": {
          this.activeLogins.delete(params.sessionKey);
          const baseUrl = status.baseurl ?? active.currentBaseUrl ?? this.options.baseUrl ?? DEFAULT_API_BASE_URL;
          await this.saveSession({
            accountId: status.ilink_bot_id,
            token: status.bot_token,
            baseUrl,
            userId: status.ilink_user_id
          });
          return {
            connected: true,
            accountId: status.ilink_bot_id,
            userId: status.ilink_user_id,
            token: status.bot_token,
            baseUrl,
            message: "微信绑定成功。"
          };
        }
      }
      await sleep(this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    }

    this.activeLogins.delete(params.sessionKey);
    return { connected: false, message: "扫码超时，请重试。" };
  }

  async pollInboxOnce(onMessage: (event: ClawBotInboundEvent) => Promise<void> | void): Promise<void> {
    const session = await this.requireSession();
    if (!session.token || !session.accountId) {
      throw new Error("ClawBot session is incomplete. Please login again.");
    }

    const response = await this.postJson<GetUpdatesResponse>({
      baseUrl: session.baseUrl,
      endpoint: "ilink/bot/getupdates",
      token: session.token,
      timeoutMs: this.nextLongPollTimeoutMs,
      body: {
        get_updates_buf: session.getUpdatesBuf ?? "",
        base_info: this.buildBaseInfo()
      }
    });

    if ((response.ret ?? 0) !== 0 || (response.errcode ?? 0) !== 0) {
      throw new Error(`getupdates failed: ret=${response.ret ?? 0} errcode=${response.errcode ?? 0} ${response.errmsg ?? ""}`.trim());
    }

    if (response.longpolling_timeout_ms && response.longpolling_timeout_ms > 0) {
      this.nextLongPollTimeoutMs = response.longpolling_timeout_ms;
    }

    const contextTokens: Record<string, string> = {};
    if (response.get_updates_buf) {
      await this.saveSession({ getUpdatesBuf: response.get_updates_buf });
    }

    for (const message of response.msgs ?? []) {
      const text = normalizeText(message);
      const fromUserId = message.from_user_id?.trim();
      if (!fromUserId || !text) {
        continue;
      }

      if (message.context_token) {
        contextTokens[fromUserId] = message.context_token;
      }

      await onMessage({
        accountId: session.accountId,
        fromUserId,
        toUserId: message.to_user_id,
        messageId: String(message.message_id ?? message.client_id ?? crypto.randomUUID()),
        text,
        contextToken: message.context_token,
        raw: message
      });
    }

    if (Object.keys(contextTokens).length > 0) {
      await this.saveSession({ contextTokens });
    }
  }

  async startReceiveLoop(options: StartReceiveLoopOptions): Promise<void> {
    while (!options.signal?.aborted) {
      try {
        await this.pollInboxOnce(options.onMessage);
      } catch (error) {
        await options.onError?.(error);
        if (options.signal?.aborted) {
          return;
        }
        await sleep(this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
      }
    }
  }

  async sendText(params: { toUserId: string; text: string; contextToken?: string }): Promise<{ messageId: string }> {
    const session = await this.requireSession();
    if (!session.token) {
      throw new Error("ClawBot token is missing. Please login again.");
    }

    const clientId = `hermes-router:${Date.now()}:${crypto.randomBytes(4).toString("hex")}`;
    const response = await this.postJson<SendMessageResponse>({
      baseUrl: session.baseUrl,
      endpoint: "ilink/bot/sendmessage",
      token: session.token,
      body: {
        msg: {
          from_user_id: "",
          to_user_id: params.toUserId,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          item_list: [
            {
              type: 1,
              text_item: {
                text: params.text
              }
            }
          ],
          context_token: params.contextToken ?? session.contextTokens[params.toUserId]
        },
        base_info: this.buildBaseInfo()
      }
    });
    if ((response.ret ?? 0) !== 0 || (response.errcode ?? 0) !== 0) {
      throw new Error(`sendmessage failed: ret=${response.ret ?? 0} errcode=${response.errcode ?? 0} ${response.errmsg ?? ""}`.trim());
    }

    return { messageId: clientId };
  }

  async sendTextChunks(params: {
    toUserId: string;
    text: string;
    contextToken?: string;
    maxChars?: number;
  }): Promise<Array<{ messageId: string; text: string }>> {
    const chunks = splitTextChunks(params.text, params.maxChars ?? 1200);
    const sent: Array<{ messageId: string; text: string }> = [];
    for (const chunk of chunks) {
      const result = await this.sendText({
        toUserId: params.toUserId,
        text: chunk,
        contextToken: params.contextToken
      });
      sent.push({ messageId: result.messageId, text: chunk });
    }
    return sent;
  }

  async sendTyping(params: {
    toUserId: string;
    contextToken?: string;
    status?: "start" | "stop";
  }): Promise<void> {
    const session = await this.requireSession();
    if (!session.token) {
      throw new Error("ClawBot token is missing. Please login again.");
    }

    const typingTicket = await this.ensureTypingTicket(params.toUserId, params.contextToken);
    if (!typingTicket) {
      return;
    }

    const response = await this.postJson<SendMessageResponse>({
      baseUrl: session.baseUrl,
      endpoint: "ilink/bot/sendtyping",
      token: session.token,
      body: {
        ilink_user_id: params.toUserId,
        typing_ticket: typingTicket,
        status: params.status === "stop" ? 2 : 1,
        base_info: this.buildBaseInfo()
      }
    });
    if ((response.ret ?? 0) !== 0 || (response.errcode ?? 0) !== 0) {
      throw new Error(`sendtyping failed: ret=${response.ret ?? 0} errcode=${response.errcode ?? 0} ${response.errmsg ?? ""}`.trim());
    }
  }

  private async pollQrStatus(active: ActiveLogin): Promise<QRStatusResponse> {
    const endpoint = new URL("ilink/bot/get_qrcode_status", ensureTrailingSlash(active.currentBaseUrl));
    endpoint.searchParams.set("qrcode", active.qrCode);
    if (active.pendingVerifyCode) {
      endpoint.searchParams.set("verify_code", active.pendingVerifyCode);
    }

    try {
      return await this.getJson<QRStatusResponse>({
        url: endpoint.toString(),
        timeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS
      });
    } catch (error) {
      if (isAbortError(error)) {
        return { status: "wait" };
      }
      throw error;
    }
  }

  private buildBaseInfo(): { channel_version: string; bot_agent: string } {
    return {
      channel_version: this.apiVersion,
      bot_agent: this.botAgent
    };
  }

  private buildHeaders(token?: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": randomWechatUin(),
      "iLink-App-Id": "bot",
      "iLink-App-ClientVersion": String(this.clientVersion)
    };
    if (token?.trim()) {
      headers.Authorization = `Bearer ${token.trim()}`;
    }
    return headers;
  }

  private async getJson<T>(params: { url: string; timeoutMs?: number }): Promise<T> {
    const controller = params.timeoutMs ? new AbortController() : undefined;
    const timer = controller && params.timeoutMs
      ? setTimeout(() => controller.abort(), params.timeoutMs)
      : undefined;
    try {
      const response = await this.fetchImpl(params.url, {
        method: "GET",
        headers: {
          "iLink-App-Id": "bot",
          "iLink-App-ClientVersion": String(this.clientVersion)
        },
        signal: controller?.signal
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`GET ${params.url} failed: ${response.status} ${text}`);
      }
      return JSON.parse(text) as T;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async postJson<T>(params: {
    baseUrl: string;
    endpoint: string;
    body: unknown;
    token?: string;
    timeoutMs?: number;
  }): Promise<T> {
    const controller = params.timeoutMs ? new AbortController() : undefined;
    const timer = controller && params.timeoutMs
      ? setTimeout(() => controller.abort(), params.timeoutMs)
      : undefined;
    try {
      const response = await this.fetchImpl(new URL(params.endpoint, ensureTrailingSlash(params.baseUrl)).toString(), {
        method: "POST",
        headers: this.buildHeaders(params.token),
        body: JSON.stringify(params.body),
        signal: controller?.signal
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`POST ${params.endpoint} failed: ${response.status} ${text}`);
      }
      return JSON.parse(text) as T;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async requireSession(): Promise<ClawBotSession> {
    const session = await this.loadSession();
    if (!session) {
      throw new Error("ClawBot session not found. Please scan QR first.");
    }
    return session;
  }

  private async ensureTypingTicket(userId: string, contextToken?: string): Promise<string | undefined> {
    const session = await this.requireSession();
    const cached = session.typingTickets[userId]?.trim();
    if (cached) {
      return cached;
    }
    if (!session.token) {
      return undefined;
    }

    const response = await this.postJson<GetConfigResponse>({
      baseUrl: session.baseUrl,
      endpoint: "ilink/bot/getconfig",
      token: session.token,
      body: {
        ilink_user_id: userId,
        context_token: contextToken ?? session.contextTokens[userId],
        base_info: this.buildBaseInfo()
      }
    });

    if ((response.ret ?? 0) !== 0 || (response.errcode ?? 0) !== 0) {
      throw new Error(`getconfig failed: ret=${response.ret ?? 0} errcode=${response.errcode ?? 0} ${response.errmsg ?? ""}`.trim());
    }

    const typingTicket = response.typing_ticket?.trim();
    if (!typingTicket) {
      return undefined;
    }

    await this.saveSession({
      typingTickets: {
        [userId]: typingTicket
      }
    });
    return typingTicket;
  }
}

function splitTextChunks(text: string, maxChars: number): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return [""];
  }
  if (normalized.length <= maxChars) {
    return [normalized];
  }

  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  const pushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed) {
      chunks.push(trimmed);
    }
    current = "";
  };

  for (const paragraph of paragraphs) {
    const part = paragraph.trim();
    if (!part) {
      continue;
    }
    const candidate = current ? `${current}\n\n${part}` : part;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) {
      pushCurrent();
    }
    if (part.length <= maxChars) {
      current = part;
      continue;
    }

    let start = 0;
    while (start < part.length) {
      const slice = part.slice(start, start + maxChars);
      chunks.push(slice);
      start += maxChars;
    }
  }

  pushCurrent();
  return chunks;
}
