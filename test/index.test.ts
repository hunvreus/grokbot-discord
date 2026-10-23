import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker, { type Env, configProblems, describeWebhookFailure, verifyDiscordRequest } from "../src/relay";

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


const ORIGINAL = "https://discord.com/api/v10/webhooks/app-1/tok-abc/messages/@original";

async function run(payload: unknown, e: Env = env()) {
  const { ctx, pending } = makeCtx();
  const res = await worker.fetch(await signedRequest(payload), e, ctx);
  await Promise.all(pending);
  return res;
}

function webhookReturning(status: number, body = "") {
  const fetchMock = vi.fn(async (url: string) => (url.includes("example.test") ? new Response(body, { status }) : new Response("{}")));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function lastEdit(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
  return { url, method: init.method, content: JSON.parse(init.body as string).content as string };
}

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

  it("returns 500 naming DISCORD_PUBLIC_KEY when it is missing or malformed", async () => {
    for (const key of ["", "abc"]) {
      const res = await worker.fetch(await signedRequest({ type: 1 }), env({ DISCORD_PUBLIC_KEY: key }), makeCtx().ctx);
      expect(res.status).toBe(500);
      expect(await res.text()).toContain("DISCORD_PUBLIC_KEY");
    }
  });
});

describe("status page", () => {
  it("lists required settings as ok when configured", async () => {
    const res = await worker.fetch(new Request("https://worker.test/"), env(), makeCtx().ctx);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("running and configured");
    expect(text).toMatch(/GROKBOT_WEBHOOK_KEY\s+ok/);
    expect(text).toMatch(/ALLOWED_GUILD_IDS\s+not set/);
    expect(text).not.toContain("secret-key");
    expect(text).not.toContain("example.test");
  });

  it("names missing settings without values", async () => {
    const res = await worker.fetch(new Request("https://worker.test/anything"), env({ GROKBOT_WEBHOOK_KEY: "", GROKBOT_WEBHOOK_URL: "not a url" }), makeCtx().ctx);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toMatch(/GROKBOT_WEBHOOK_KEY\s+is missing/);
    expect(text).toMatch(/GROKBOT_WEBHOOK_URL\s+is not a valid https:\/\/ URL/);
    expect(text).not.toContain("not a url");
  });

  it("returns 405 for other methods", async () => {
    const res = await worker.fetch(new Request("https://worker.test/", { method: "PUT" }), env(), makeCtx().ctx);
    expect(res.status).toBe(405);
  });
});

describe("config checks", () => {
  it("reports every required setting", () => {
    expect(configProblems({}).map((p) => p.name)).toEqual(["DISCORD_PUBLIC_KEY", "ALLOWED_USER_IDS", "GROKBOT_WEBHOOK_URL", "GROKBOT_WEBHOOK_KEY"]);
    expect(configProblems(env())).toEqual([]);
    expect(configProblems(env({ GROKBOT_WEBHOOK_URL: "http://example.test" }))[0].name).toBe("GROKBOT_WEBHOOK_URL");
  });

  it("validates REPLY_TTL_MINUTES and uses it for reply.expires_at", async () => {
    for (const bad of ["0", "abc", "1.5", "99999"]) {
      expect(configProblems(env({ REPLY_TTL_MINUTES: bad })).map((p) => p.name)).toEqual(["REPLY_TTL_MINUTES"]);
    }
    expect(configProblems(env({ REPLY_TTL_MINUTES: "" }))).toEqual([]);
    const fetchMock = webhookReturning(200);
    await run(command("111"), env({ REPLY_TTL_MINUTES: "180" }));
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(Date.parse(body.reply.expires_at) - Date.parse(body.received_at)).toBe(180 * 60_000);
  });

  it("tells the Discord user which variable is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await run(command("111"), env({ GROKBOT_WEBHOOK_KEY: " " }));
    const body = await res.json();
    expect(body.type).toBe(4);
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain("GROKBOT_WEBHOOK_KEY is missing");
    expect(body.data.content).toContain("#configuration");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still answers PING when the webhook settings are missing", async () => {
    const res = await run({ type: 1 }, env({ GROKBOT_WEBHOOK_URL: "", GROKBOT_WEBHOOK_KEY: "" }));
    expect(await res.json()).toEqual({ type: 1 });
  });

  it("reports an empty ALLOWED_USER_IDS as a config problem", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const body = await (await run(command("111"), env({ ALLOWED_USER_IDS: " " }))).json();
    expect(body.data.content).toContain("ALLOWED_USER_IDS is empty");
  });
});

describe("interactions", () => {
  it("answers PING with PONG", async () => {
    expect(await (await run({ type: 1 })).json()).toEqual({ type: 1 });
  });

  it("replies ephemerally to unsupported interaction and command types", async () => {
    const r1 = await (await run({ ...command("111"), type: 3 })).json();
    expect(r1.data.flags).toBe(64);
    expect(r1.data.content).toContain("only handles slash commands");
    const r2 = await (await run(command("111", { data: { name: "Ask about this", type: 3 } }))).json();
    expect(r2.data.content).toContain("not a slash command");
  });

  it("asks for a prompt when the command has no options", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const body = await (await run(command("111", { data: { name: "ask", type: 1 } }))).json();
    expect(body.data.content).toContain("needs a prompt");
  });

  it("rejects a user not on the allowlist, names the id and never forwards", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const body = await (await run(command("999"))).json();
    expect(body.type).toBe(4);
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toBe(
      "You aren't allowed to use this bot.\n" +
        "-# Your Discord user ID is `999`. If you run this bot, add it to `ALLOWED_USER_IDS`.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses DENIED_MESSAGE as the first line and still appends the id hint", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const body = await (await run(command("999"), env({ DENIED_MESSAGE: "Nope." }))).json();
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toBe("Nope.\n-# Your Discord user ID is `999`. If you run this bot, add it to `ALLOWED_USER_IDS`.");
    const blank = await (await run(command("999"), env({ DENIED_MESSAGE: "  " }))).json();
    expect(blank.data.content).toContain("You aren't allowed to use this bot.\n-# ");
  });

  it("enforces guild and channel allowlists and names the ids", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const r1 = await (await run(command("111"), env({ ALLOWED_GUILD_IDS: "g-2" }))).json();
    expect(r1.data.content).toContain("-# The server ID is `g-1`. To allow it, add it to `ALLOWED_GUILD_IDS`.");
    const r2 = await (await run(command("111"), env({ ALLOWED_CHANNEL_IDS: "c-9" }))).json();
    expect(r2.data.content).toContain("-# The channel ID is `c-1`. To allow it, add it to `ALLOWED_CHANNEL_IDS`.");
    const r3 = await (await run(command("111", { guild_id: undefined }), env({ ALLOWED_GUILD_IDS: "g-2" }))).json();
    expect(r3.data.content).toContain("direct messages");
  });

  it("defers and forwards an allowed command with the right body and auth header", async () => {
    const fetchMock = webhookReturning(200, "{}");
    const res = await run(command("222"));
    expect(await res.json()).toEqual({ type: 5 });

    // Success: no edit, Discord keeps "thinking" until the bot replies.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.test/hook");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-key");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      source: "discord",
      application_id: "app-1",
      interaction_id: "int-1",
      guild_id: "g-1",
      channel_id: "c-1",
      user: { id: "222", username: "ronan", global_name: "Ronan" },
      command: "ask",
      options: { prompt: "check #200" },
      text: "check #200",
      reply: { method: "POST", body: { content: "<your answer in Markdown, any length>" } },
    });
    expect(Date.parse(body.received_at)).not.toBeNaN();
    // One way to reply: the interaction token is only inside the encrypted reply URL.
    expect(body).not.toHaveProperty("interaction_token");
    expect(body).not.toHaveProperty("edit_original_url");
    expect(body).not.toHaveProperty("followup_url");
    expect(JSON.stringify(body)).not.toContain("tok-abc");
    expect(body.reply.url).toMatch(/^https:\/\/worker\.test\/reply\/[A-Za-z0-9_-]+$/);
    expect(Date.parse(body.reply.expires_at) - Date.parse(body.received_at)).toBe(60 * 60_000);
    expect(body.reply.instructions).toContain("reply.url");
    expect(body.reply.instructions).toContain('"progress": true');
  });

  it("sends the key as a Bearer token in the Authorization header", async () => {
    const fetchMock = webhookReturning(200);
    await run(command("111"), env({ GROKBOT_WEBHOOK_KEY: "  secret-key  " }));
    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-key");
  });

  it("flattens subcommands into the command path", async () => {
    const fetchMock = webhookReturning(200);
    await run(command("111", { data: { name: "bot", options: [{ name: "issue", type: 1, options: [{ name: "number", type: 4, value: 200 }] }] } }));
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.command).toBe("bot issue");
    expect(body.options).toEqual({ number: 200 });
    expect(body.text).toBe("number: 200");
  });
});

describe("webhook failures", () => {
  it.each([
    [401, "rejected the key", "GROKBOT_WEBHOOK_KEY"],
    [403, "rejected the key", "GROKBOT_WEBHOOK_KEY"],
    [404, "URL was not found", "GROKBOT_WEBHOOK_URL"],
    [429, "rate limiting", "HTTP 429"],
    [502, "server error", "HTTP 502"],
    [418, "returned HTTP 418", "HTTP 418"],
  ])("edits the deferred message for HTTP %i", async (status, phrase, mention) => {
    const fetchMock = webhookReturning(status, '{"message":"Invalid API key"}');
    await run(command("111"));
    const edit = lastEdit(fetchMock);
    expect(edit.url).toBe(ORIGINAL);
    expect(edit.method).toBe("PATCH");
    expect(edit.content).toContain(phrase);
    expect(edit.content).toContain(mention);
    expect(edit.content).toContain("Invalid API key");
    expect(edit.content).not.toContain("secret-key");
  });

  it("points key problems at the secret and URL problems at the variables", () => {
    expect(describeWebhookFailure(401, "")).toContain("wrangler secret put GROKBOT_WEBHOOK_KEY");
    expect(describeWebhookFailure(404, "")).toContain("Text variables");
    expect(describeWebhookFailure(404, "")).not.toContain("wrangler secret put");
  });

  it("edits the deferred message when the webhook is unreachable", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("example.test")) throw new Error("connection refused");
      return new Response("{}");
    });
    vi.stubGlobal("fetch", fetchMock);
    await run(command("111"));
    expect(lastEdit(fetchMock).content).toContain("Could not reach the webhook (connection refused)");
  });

  it("logs one line per forward with the status and never the key", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
    webhookReturning(403, "nope");
    await run(command("111"));
    spy.mockRestore();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("[forward int-1] status=403");
    expect(logs[0]).toContain("nope");
    expect(logs.join("\n")).not.toContain("secret-key");
  });
});
