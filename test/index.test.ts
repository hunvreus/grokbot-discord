import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker, { type Env, verifyDiscordRequest } from "../src/index";

let keys: CryptoKeyPair;
let publicKeyHex: string;

const toHex = (buf: ArrayBuffer) => Buffer.from(buf).toString("hex");

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  publicKeyHex = toHex(await crypto.subtle.exportKey("raw", keys.publicKey));
});

afterEach(() => vi.unstubAllGlobals());

function env(overrides: Partial<Env> = {}): Env {
  return {
    DISCORD_PUBLIC_KEY: publicKeyHex,
    ALLOWED_USER_IDS: "111, 222",
    GROKBOT_WEBHOOK_URL: "https://example.test/hook",
    GROKBOT_WEBHOOK_KEY: "secret-key",
    ...overrides,
  };
}

function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return { ctx: { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext, pending };
}

async function signedRequest(payload: unknown, opts: { badSig?: boolean } = {}) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(timestamp + body));
  let sigHex = toHex(sig);
  if (opts.badSig) sigHex = (sigHex[0] === "0" ? "1" : "0") + sigHex.slice(1);
  return new Request("https://worker.test/", {
    method: "POST",
    headers: { "X-Signature-Ed25519": sigHex, "X-Signature-Timestamp": timestamp, "Content-Type": "application/json" },
    body,
  });
}

const command = (userId: string, extra: Record<string, unknown> = {}) => ({
  id: "int-1",
  application_id: "app-1",
  type: 2,
  token: "tok-abc",
  guild_id: "g-1",
  channel_id: "c-1",
  member: { user: { id: userId, username: "ronan", global_name: "Ronan" } },
  data: { name: "ask", options: [{ name: "prompt", type: 3, value: "check #200" }] },
  ...extra,
});

describe("signature verification", () => {
  it("accepts a valid signature", async () => {
    const body = '{"type":1}';
    const ts = "1700000000";
    const sig = toHex(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(ts + body)));
    expect(await verifyDiscordRequest(body, sig, ts, publicKeyHex)).toBe(true);
  });

  it("rejects a tampered body, bad hex and missing headers", async () => {
    const ts = "1700000000";
    const sig = toHex(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(ts + "a")));
    expect(await verifyDiscordRequest("b", sig, ts, publicKeyHex)).toBe(false);
    expect(await verifyDiscordRequest("a", "zz", ts, publicKeyHex)).toBe(false);
    expect(await verifyDiscordRequest("a", null, ts, publicKeyHex)).toBe(false);
    expect(await verifyDiscordRequest("a", sig, ts, "")).toBe(false);
  });

  it("returns 401 for a bad signature", async () => {
    const res = await worker.fetch(await signedRequest({ type: 1 }, { badSig: true }), env(), makeCtx().ctx);
    expect(res.status).toBe(401);
  });
});

describe("interactions", () => {
  it("answers PING with PONG", async () => {
    const res = await worker.fetch(await signedRequest({ type: 1 }), env(), makeCtx().ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: 1 });
  });

  it("rejects a user not on the allowlist and never forwards", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, pending } = makeCtx();
    const res = await worker.fetch(await signedRequest(command("999")), env(), ctx);
    expect(await res.json()).toEqual({ type: 4, data: { content: "Not allowed.", flags: 64 } });
    expect(pending).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when ALLOWED_USER_IDS is empty", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const res = await worker.fetch(await signedRequest(command("111")), env({ ALLOWED_USER_IDS: " " }), makeCtx().ctx);
    expect((await res.json()).data.content).toBe("Not allowed.");
  });

  it("enforces guild and channel allowlists when set", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const r1 = await worker.fetch(await signedRequest(command("111")), env({ ALLOWED_GUILD_IDS: "g-2" }), makeCtx().ctx);
    expect((await r1.json()).type).toBe(4);
    const r2 = await worker.fetch(await signedRequest(command("111")), env({ ALLOWED_CHANNEL_IDS: "c-9" }), makeCtx().ctx);
    expect((await r2.json()).type).toBe(4);
  });

  it("defers and forwards an allowed command with the right body and auth header", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, pending } = makeCtx();
    const res = await worker.fetch(await signedRequest(command("222")), env(), ctx);
    expect(await res.json()).toEqual({ type: 5 });
    await Promise.all(pending);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.test/hook");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-key");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      source: "discord",
      application_id: "app-1",
      interaction_id: "int-1",
      interaction_token: "tok-abc",
      guild_id: "g-1",
      channel_id: "c-1",
      user: { id: "222", username: "ronan", global_name: "Ronan" },
      command: "ask",
      options: { prompt: "check #200" },
      text: "check #200",
      followup_url: "https://discord.com/api/v10/webhooks/app-1/tok-abc",
      edit_original_url: "https://discord.com/api/v10/webhooks/app-1/tok-abc/messages/@original",
    });
    expect(Date.parse(body.received_at)).not.toBeNaN();
  });

  it("supports a custom auth header with a raw value", async () => {
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, pending } = makeCtx();
    const e = env({ GROKBOT_WEBHOOK_AUTH_HEADER: "X-Sender-Key", GROKBOT_WEBHOOK_AUTH_SCHEME: "" });
    await worker.fetch(await signedRequest(command("111")), e, ctx);
    await Promise.all(pending);
    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers["X-Sender-Key"]).toBe("secret-key");
    expect(headers.Authorization).toBeUndefined();
  });

  it("patches the original message when the webhook fails", async () => {
    const fetchMock = vi.fn(async (url: string) => new Response("", { status: url.includes("example.test") ? 500 : 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, pending } = makeCtx();
    await worker.fetch(await signedRequest(command("111")), env(), ctx);
    await Promise.all(pending);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("https://discord.com/api/v10/webhooks/app-1/tok-abc/messages/@original");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string).content).toContain("HTTP 500");
  });

  it("patches 'Sent to Grug.' after a successful forward", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, pending } = makeCtx();
    await worker.fetch(await signedRequest(command("111")), env(), ctx);
    await Promise.all(pending);
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("https://discord.com/api/v10/webhooks/app-1/tok-abc/messages/@original");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string).content).toBe("Sent to Grug.");
  });

  it("patches an error when the webhook is unreachable", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("example.test")) throw new Error("boom");
      return new Response("", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, pending } = makeCtx();
    await worker.fetch(await signedRequest(command("111")), env(), ctx);
    await Promise.all(pending);
    const init = (fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string).content).toContain("could not be reached");
  });

  it("logs the webhook status but never the key", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(url.includes("example.test") ? "nope" : "", { status: url.includes("example.test") ? 403 : 200 })));
    const { ctx, pending } = makeCtx();
    await worker.fetch(await signedRequest(command("111")), env(), ctx);
    await Promise.all(pending);
    spy.mockRestore();
    const all = logs.join("\n");
    expect(all).toContain("webhook status=403");
    expect(all).toContain("nope");
    expect(all).not.toContain("secret-key");
  });

  it("flattens subcommands into the command path", async () => {
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, pending } = makeCtx();
    const cmd = command("111", {
      data: { name: "bot", options: [{ name: "issue", type: 1, options: [{ name: "number", type: 4, value: 200 }] }] },
    });
    await worker.fetch(await signedRequest(cmd), env(), ctx);
    await Promise.all(pending);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.command).toBe("bot issue");
    expect(body.options).toEqual({ number: 200 });
    expect(body.text).toBe("number: 200");
  });
});
