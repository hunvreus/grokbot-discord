import { afterEach, describe, expect, it, vi } from "vitest";
import worker, {
  type Env,
  type ReplyRef,
  MAX_REPLY_LENGTH,
  handleReply,
  openRef,
  sealRef,
  splitMessage,
} from "../src/relay";

const KEY = "secret-key";
const BOT = "bot-token-xyz";
const T0 = Date.parse("2026-10-23T02:00:00.000Z");
const MIN = 60_000;
const HOOK = "https://discord.com/api/v10/webhooks/app-1/tok-abc";
const ORIGINAL = `${HOOK}/messages/@original`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const env = (overrides: Partial<Env> = {}): Env => ({ GROKBOT_WEBHOOK_KEY: KEY, ...overrides });

function ref(overrides: Partial<ReplyRef> = {}): ReplyRef {
  return { a: "app-1", t: "tok-abc", c: "c-1", g: "g-1", u: "111", i: "int-1", r: T0, e: T0 + 60 * MIN, ...overrides };
}

async function replyUrl(r: ReplyRef = ref(), key = KEY) {
  return `https://worker.test/reply/${await sealRef(r, key)}`;
}

type Call = { url: string; method: string; headers: Record<string, string>; body: any };

/** Stubs fetch. `respond` decides each Discord response; default is 200 with an id. */
function discord(respond: (c: Call, n: number) => Response | undefined = () => undefined) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const c = { url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
      calls.push(c);
      return respond(c, calls.length - 1) ?? Response.json({ id: `m${calls.length}` });
    }),
  );
  return calls;
}

const discordError = (status: number, code: number, message: string) => Response.json({ code, message }, { status });

async function post(url: string, body: unknown, opts: { env?: Env; now?: number; type?: string } = {}) {
  const req = new Request(url, {
    method: "POST",
    headers: { "Content-Type": opts.type ?? "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const res = await handleReply(req, new URL(url), opts.env ?? env(), opts.now ?? T0 + 1 * MIN);
  return { status: res.status, body: (await res.json()) as any };
}

describe("reply refs", () => {
  it("round-trips and hides the interaction token", async () => {
    const sealed = await sealRef(ref(), KEY);
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain("tok-abc");
    expect(atob(sealed.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(sealed.length / 4) * 4, "="))).not.toContain("tok-abc");
    expect(await openRef(sealed, KEY)).toEqual(ref());
  });

  it("rejects a tampered ref, a different key and garbage", async () => {
    const sealed = await sealRef(ref(), KEY);
    const flipped = sealed.slice(0, 20) + (sealed[20] === "A" ? "B" : "A") + sealed.slice(21);
    expect(await openRef(flipped, KEY)).toBeNull();
    expect(await openRef(sealed, "other-key")).toBeNull();
    expect(await openRef("not*base64", KEY)).toBeNull();
    expect(await openRef("AAAA", KEY)).toBeNull();
  });
});

describe("POST /reply: access", () => {
  it("is routed by the Worker without a Discord signature", async () => {
    const calls = discord();
    const res = await worker.fetch(
      new Request(await replyUrl(), { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"content":"hi"}' }),
      env(),
      {} as ExecutionContext,
    );
    // Real clock: the ref was made for T0, so it's long expired. That still proves routing.
    expect(res.status).toBe(410);
    expect(calls).toHaveLength(0);
  });

  it("returns 403 for a tampered or foreign reply URL and never calls Discord", async () => {
    const calls = discord();
    const url = await replyUrl();
    const tampered = url.slice(0, -3) + (url.endsWith("AAA") ? "BBB" : "AAA");
    for (const u of [tampered, await replyUrl(ref(), "other-key")]) {
      const r = await post(u, { content: "hi" });
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ ok: false, error: "invalid_reply_url" });
    }
    expect(calls).toHaveLength(0);
  });

  it("returns 400 when the ref is missing, 405 for GET and 500 when the key is unset", async () => {
    expect((await post("https://worker.test/reply", { content: "hi" })).body.error).toBe("missing_ref");
    const get = await handleReply(new Request(await replyUrl()), new URL(await replyUrl()), env(), T0);
    expect(get.status).toBe(405);
    expect(get.headers.get("Allow")).toBe("POST");
    const r = await post(await replyUrl(), { content: "hi" }, { env: env({ GROKBOT_WEBHOOK_KEY: "" }) });
    expect(r.status).toBe(500);
    expect(r.body.message).toContain("GROKBOT_WEBHOOK_KEY");
  });

  it("returns 410 once the reply URL itself has expired", async () => {
    const calls = discord();
    const r = await post(await replyUrl(), { content: "hi" }, { now: T0 + 61 * MIN });
    expect(r.status).toBe(410);
    expect(r.body.error).toBe("reply_url_expired");
    expect(r.body.message).toContain("REPLY_TTL_MINUTES");
    expect(calls).toHaveLength(0);
  });
});

describe("POST /reply: body", () => {
  it.each([
    ["not json", "invalid_json", 400],
    [[1, 2], "invalid_body", 400],
    [{}, "missing_content", 400],
    [{ content: 5 }, "missing_content", 400],
    [{ content: "  " }, "empty_content", 400],
    [{ content: "hi", progress: "yes" }, "invalid_progress", 400],
    [{ content: "x".repeat(MAX_REPLY_LENGTH + 1) }, "content_too_long", 413],
  ])("rejects %j with %s", async (body, error, status) => {
    const calls = discord();
    const r = await post(await replyUrl(), body);
    expect(r.status).toBe(status);
    expect(r.body).toMatchObject({ ok: false, error });
    expect(typeof r.body.message).toBe("string");
    expect(calls).toHaveLength(0);
  });

  it("accepts a text/plain body as the content", async () => {
    const calls = discord();
    const r = await post(await replyUrl(), "plain answer", { type: "text/plain; charset=utf-8" });
    expect(r.status).toBe(200);
    expect(calls[0].body.content).toBe("plain answer");
  });
});

describe("POST /reply: within 15 minutes", () => {
  it("replaces the thinking message without pinging anyone", async () => {
    const calls = discord();
    const r = await post(await replyUrl(), { content: "Issue #200 is fixed by #204." });
    expect(r).toEqual({ status: 200, body: { ok: true, via: "interaction", messages: 1, message_ids: ["m1"] } });
    expect(calls).toEqual([
      {
        url: ORIGINAL,
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: { content: "Issue #200 is fixed by #204.", allowed_mentions: { parse: [] } },
      },
    ]);
  });

  it("splits a long answer into an edit plus follow-ups", async () => {
    const calls = discord();
    const para = "word ".repeat(300).trim(); // 1499 chars
    const r = await post(await replyUrl(), { content: [para, para, para].join("\n\n") });
    expect(r.body.messages).toBe(3);
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["PATCH", ORIGINAL],
      ["POST", `${HOOK}?wait=true`],
      ["POST", `${HOOK}?wait=true`],
    ]);
    for (const c of calls) {
      expect(c.body.content).toBe(para);
      expect(c.body.allowed_mentions).toEqual({ parse: [] });
    }
  });

  it("posts a follow-up when the thinking message was deleted", async () => {
    const calls = discord((c) => (c.method === "PATCH" ? discordError(404, 10008, "Unknown Message") : undefined));
    const r = await post(await replyUrl(), { content: "hi" });
    expect(r.status).toBe(200);
    expect(calls.map((c) => c.method)).toEqual(["PATCH", "POST"]);
  });

  it("returns 502 with Discord's status, code and message", async () => {
    discord(() => discordError(400, 50035, "Invalid Form Body"));
    const r = await post(await replyUrl(), { content: "hi" });
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({
      ok: false,
      error: "discord_error",
      discord: { status: 400, code: 50035, message: "Invalid Form Body" },
      messages_sent: 0,
    });
    expect(r.body.message).toContain("Invalid Form Body");
    expect(JSON.stringify(r.body)).not.toContain("tok-abc");
  });

  it("reports how many parts were sent when a follow-up fails", async () => {
    discord((_c, n) => (n === 1 ? discordError(403, 50001, "Missing Access") : undefined));
    const r = await post(await replyUrl(), { content: "a".repeat(1500) + "\n\n" + "b".repeat(1500) });
    expect(r.status).toBe(502);
    expect(r.body.messages_sent).toBe(1);
    expect(r.body.message).toContain("message 2 of 2");
  });

  it("returns 502 when Discord can't be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const r = await post(await replyUrl(), { content: "hi" });
    expect(r.status).toBe(502);
    expect(r.body.discord.status).toBe(0);
    expect(r.body.message).toContain("network down");
  });

  it("retries once after a short rate limit", async () => {
    const calls = discord((_c, n) => (n === 0 ? Response.json({ message: "You are being rate limited.", retry_after: 0.01 }, { status: 429 }) : undefined));
    const r = await post(await replyUrl(), { content: "hi" });
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("logs one line without the token or the content", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
    discord();
    await post(await replyUrl(), { content: "private answer" });
    expect(logs).toEqual(["[reply int-1] status=200 via=interaction messages=1"]);
  });
});

describe("POST /reply: after 15 minutes", () => {
  const late = T0 + 20 * MIN;

  it("returns 410 when DISCORD_BOT_TOKEN isn't set", async () => {
    const calls = discord();
    const r = await post(await replyUrl(), { content: "hi" }, { now: late });
    expect(r.status).toBe(410);
    expect(r.body.error).toBe("interaction_expired");
    expect(r.body.message).toContain("DISCORD_BOT_TOKEN");
    expect(calls).toHaveLength(0);
  });

  it("posts in the channel with the bot token and mentions the user once", async () => {
    const calls = discord();
    const r = await post(await replyUrl(), { content: "a".repeat(1500) + "\n\n" + "b".repeat(1500) }, { now: late, env: env({ DISCORD_BOT_TOKEN: BOT }) });
    expect(r.body).toMatchObject({ ok: true, via: "channel", messages: 2 });
    expect(calls.map((c) => c.url)).toEqual(Array(2).fill("https://discord.com/api/v10/channels/c-1/messages"));
    expect(calls[0].headers.Authorization).toBe(`Bot ${BOT}`);
    expect(calls[0].body).toEqual({ content: `<@111> ${"a".repeat(1500)}`, allowed_mentions: { users: ["111"] } });
    expect(calls[1].body).toEqual({ content: "b".repeat(1500), allowed_mentions: { parse: [] } });
  });

  it("falls back when Discord says the interaction token is invalid", async () => {
    const calls = discord((c) => (c.url.includes("/webhooks/") ? discordError(401, 50027, "Invalid Webhook Token") : undefined));
    const r = await post(await replyUrl(), { content: "hi" }, { now: T0 + 14 * MIN, env: env({ DISCORD_BOT_TOKEN: BOT }) });
    expect(r.body.via).toBe("channel");
    expect(calls.map((c) => c.method + " " + c.url)).toEqual([`PATCH ${ORIGINAL}`, "POST https://discord.com/api/v10/channels/c-1/messages"]);
  });

  it("includes Discord's error in the 410 when the token was rejected and no bot token is set", async () => {
    discord(() => discordError(401, 50027, "Invalid Webhook Token"));
    const r = await post(await replyUrl(), { content: "hi" }, { now: T0 + 14 * MIN });
    expect(r.status).toBe(410);
    expect(r.body.discord).toEqual({ status: 401, code: 50027, message: "Invalid Webhook Token" });
  });

  it("opens a DM when the command came from a DM", async () => {
    const calls = discord((c) => (c.url.endsWith("/users/@me/channels") ? Response.json({ id: "dm-9" }) : undefined));
    const r = await post(await replyUrl(ref({ g: null, c: "c-dm" })), { content: "hi" }, { now: late, env: env({ DISCORD_BOT_TOKEN: BOT }) });
    expect(r.status).toBe(200);
    expect(calls[0].body).toEqual({ recipient_id: "111" });
    expect(calls[1].url).toBe("https://discord.com/api/v10/channels/dm-9/messages");
  });

  it("explains a bad bot token and missing channel access", async () => {
    discord(() => discordError(401, 0, "401: Unauthorized"));
    const bad = await post(await replyUrl(), { content: "hi" }, { now: late, env: env({ DISCORD_BOT_TOKEN: BOT }) });
    expect(bad.status).toBe(502);
    expect(bad.body.message).toContain("rejected DISCORD_BOT_TOKEN");
    expect(JSON.stringify(bad.body)).not.toContain(BOT);
    discord(() => discordError(403, 50001, "Missing Access"));
    const denied = await post(await replyUrl(), { content: "hi" }, { now: late, env: env({ DISCORD_BOT_TOKEN: BOT }) });
    expect(denied.body.message).toContain("Send Messages");
    expect(denied.body.discord.code).toBe(50001);
  });

  it("skips progress notes instead of pinging the user", async () => {
    const calls = discord();
    const r = await post(await replyUrl(), { content: "Working on it", progress: true }, { now: late, env: env({ DISCORD_BOT_TOKEN: BOT }) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, messages: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe("splitMessage", () => {
  it("keeps short text whole", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
    expect(splitMessage("x".repeat(2000))).toHaveLength(1);
  });

  it("prefers paragraph, then line, then word boundaries", () => {
    expect(splitMessage("aaaa\n\nbbbb", 8)).toEqual(["aaaa", "bbbb"]);
    expect(splitMessage("aaaaaa bbbbbbbbbb\ncccccc", 22)).toEqual(["aaaaaa bbbbbbbbbb", "cccccc"]);
    expect(splitMessage("aaaaaaaaaa bbbbbbbbbb", 16)).toEqual(["aaaaaaaaaa", "bbbbbbbbbb"]);
  });

  it("hard-splits text without spaces and never exceeds the limit", () => {
    const parts = splitMessage("x".repeat(5000));
    expect(parts.every((p) => p.length <= 2000)).toBe(true);
    expect(parts.join("")).toBe("x".repeat(5000));
  });

  it("doesn't cut an emoji in half", () => {
    const parts = splitMessage("😀".repeat(1500));
    expect(parts.join("")).toBe("😀".repeat(1500));
    for (const p of parts) expect(p).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
  });

  it("closes and reopens a code block that spans messages", () => {
    const code = Array.from({ length: 300 }, (_, i) => `const line${i} = ${i};`).join("\n");
    const parts = splitMessage("Here:\n\n```ts\n" + code + "\n```\nDone.");
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(2000);
      expect((p.match(/^```/gm) ?? []).length % 2).toBe(0);
    }
    expect(parts[1].startsWith("```ts\n")).toBe(true);
    expect(parts.at(-1)!.endsWith("Done.")).toBe(true);
  });
});
