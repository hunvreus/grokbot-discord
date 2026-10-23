/**
 * grokbot-discord: relays Discord slash commands to a Grok Bot routine webhook,
 * and posts the routine's answers back to Discord through POST /reply/<ref>.
 * Setup and troubleshooting: see README.md.
 */

export interface Env {
  DISCORD_PUBLIC_KEY?: string;
  ALLOWED_USER_IDS?: string;
  ALLOWED_GUILD_IDS?: string;
  ALLOWED_CHANNEL_IDS?: string;
  GROKBOT_WEBHOOK_URL?: string;
  GROKBOT_WEBHOOK_KEY?: string;
  DENIED_MESSAGE?: string;
  DISCORD_BOT_TOKEN?: string;
  REPLY_TTL_MINUTES?: string;
}

export const README_URL = "https://github.com/hunvreus/grokbot-discord#readme";
const TROUBLESHOOTING_URL = "https://github.com/hunvreus/grokbot-discord#troubleshooting";
const DISCORD_API = "https://discord.com/api/v10";
const SET_KEY_HINT =
  "Set GROKBOT_WEBHOOK_KEY as a secret in the Cloudflare dashboard (Worker > Settings > Variables and Secrets) or with " +
  "`npx wrangler secret put GROKBOT_WEBHOOK_KEY`, and paste the value yourself: automated tools can mangle secrets.";
const SET_VARS_HINT =
  "Set the other settings as Text variables in the Cloudflare dashboard (Worker > Settings > Variables and Secrets).";

/** Discord interaction tokens last 15 minutes. After that, replies need the bot token. */
export const INTERACTION_TOKEN_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_REPLY_TTL_MINUTES = 60;
const MAX_MESSAGE_LENGTH = 2000;
/** Longest reply the Worker accepts: 10 Discord messages. */
export const MAX_REPLY_LENGTH = 20000;
export const REPLY_INSTRUCTIONS =
  "To answer, POST JSON {\"content\": \"<your answer in Markdown>\"} to reply.url (no auth header needed) once with your final answer; long answers are split into several messages automatically, and you may first post a short progress note with {\"content\": \"...\", \"progress\": true}.";

// Interaction types
const PING = 1;
const APPLICATION_COMMAND = 2;
// Application command types
const CHAT_INPUT = 1;
// Interaction callback types
const PONG = 1;
const CHANNEL_MESSAGE_WITH_SOURCE = 4;
const DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5;
// Message flags
const EPHEMERAL = 1 << 6;

interface DiscordUser {
  id: string;
  username?: string;
  global_name?: string | null;
}

interface CommandOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: CommandOption[];
}

export interface Interaction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  guild_id?: string;
  channel_id?: string;
  channel?: { id: string };
  member?: { user: DiscordUser };
  user?: DiscordUser;
  data?: { name: string; type?: number; options?: CommandOption[] };
}

export interface ReplyInfo {
  url: string;
  method: "POST";
  body: { content: string; progress?: boolean };
  expires_at: string;
  instructions: string;
}

export interface WebhookPayload {
  source: "discord";
  application_id: string;
  interaction_id: string;
  guild_id: string | null;
  channel_id: string | null;
  user: { id: string; username: string | null; global_name: string | null };
  command: string;
  options: Record<string, string | number | boolean>;
  text: string;
  received_at: string;
  reply: ReplyInfo;
}

/** What a reply URL carries, encrypted. Short keys keep the URL short. */
export interface ReplyRef {
  a: string; // application id
  t: string; // interaction token
  c: string | null; // channel id
  g: string | null; // guild id
  u: string; // user id
  i: string; // interaction id
  r: number; // received at, ms
  e: number; // reply URL expires at, ms
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/reply" || url.pathname.startsWith("/reply/")) return handleReply(request, url, env);
    if (request.method === "GET" || request.method === "HEAD") return statusPage(env);
    if (request.method !== "POST") return new Response("Method not allowed.", { status: 405 });

    // Without a usable public key nothing can be verified. Discord will refuse to save the endpoint.
    const keyProblem = configProblems(env).find((p) => p.name === "DISCORD_PUBLIC_KEY");
    if (keyProblem) {
      console.log(`[config] ${keyProblem.name}: ${keyProblem.problem}`);
      return new Response(`Worker misconfigured: ${keyProblem.name} ${keyProblem.problem}. See ${README_URL}`, { status: 500 });
    }

    const body = await request.text();
    const valid = await verifyDiscordRequest(
      body,
      request.headers.get("X-Signature-Ed25519"),
      request.headers.get("X-Signature-Timestamp"),
      env.DISCORD_PUBLIC_KEY,
    );
    if (!valid) return new Response("Bad request signature.", { status: 401 });

    let interaction: Interaction;
    try {
      interaction = JSON.parse(body);
    } catch {
      return new Response("Invalid JSON.", { status: 400 });
    }

    if (interaction.type === PING) return json({ type: PONG });
    if (interaction.type !== APPLICATION_COMMAND) {
      return ephemeral(`This bot only handles slash commands (got interaction type ${interaction.type}).`);
    }
    if (interaction.data?.type !== undefined && interaction.data.type !== CHAT_INPUT) {
      return ephemeral(`/${interaction.data.name} is not a slash command. This bot only handles slash commands.`);
    }

    const problems = configProblems(env);
    if (problems.length > 0) {
      const lines = problems.map((p) => `- ${p.name} ${p.problem}`).join("\n");
      console.log(`[config] ${problems.map((p) => p.name).join(", ")}`);
      return ephemeral(`The bot is not configured yet:\n${lines}\nSee ${README_URL}#configuration. ${SET_VARS_HINT} ${SET_KEY_HINT}`);
    }

    const rejection = rejectionMessage(interaction, env);
    if (rejection) return ephemeral(rejection);

    const payload = await buildPayload(interaction, env, url.origin);
    if (!payload.text.trim()) return ephemeral(`/${payload.command} needs a prompt. Try \`/${payload.command} prompt: hello\`.`);

    ctx.waitUntil(forward(payload, env, interaction));
    return json({ type: DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
  },
};

export interface ConfigProblem {
  name: keyof Env;
  problem: string;
}

/** Required settings that are missing or malformed. Never includes values. */
export function configProblems(env: Env): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const key = (env.DISCORD_PUBLIC_KEY ?? "").trim();
  if (!key) problems.push({ name: "DISCORD_PUBLIC_KEY", problem: "is missing" });
  else if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    problems.push({ name: "DISCORD_PUBLIC_KEY", problem: "is not a 64-character hex key (copy Public Key from the Developer Portal)" });
  }
  if (parseList(env.ALLOWED_USER_IDS).length === 0) {
    problems.push({ name: "ALLOWED_USER_IDS", problem: "is empty, so nobody is allowed" });
  }
  const url = (env.GROKBOT_WEBHOOK_URL ?? "").trim();
  if (!url) problems.push({ name: "GROKBOT_WEBHOOK_URL", problem: "is missing" });
  else if (!isHttpsUrl(url)) problems.push({ name: "GROKBOT_WEBHOOK_URL", problem: "is not a valid https:// URL" });
  if (!(env.GROKBOT_WEBHOOK_KEY ?? "").trim()) problems.push({ name: "GROKBOT_WEBHOOK_KEY", problem: "is missing" });
  if (env.REPLY_TTL_MINUTES !== undefined && env.REPLY_TTL_MINUTES.trim() !== "" && replyTtlMinutes(env) === null) {
    problems.push({ name: "REPLY_TTL_MINUTES", problem: "is not a whole number of minutes between 1 and 10080" });
  }
  return problems;
}

/** Plain-text page for a browser or curl. Lists setting names and whether they are set, never values. */
function statusPage(env: Env): Response {
  const problems = new Map(configProblems(env).map((p) => [p.name, p.problem]));
  const required: (keyof Env)[] = ["DISCORD_PUBLIC_KEY", "ALLOWED_USER_IDS", "GROKBOT_WEBHOOK_URL", "GROKBOT_WEBHOOK_KEY"];
  const optional: [keyof Env, string][] = [
    ["ALLOWED_GUILD_IDS", "any server"],
    ["ALLOWED_CHANNEL_IDS", "any channel"],
    ["DISCORD_BOT_TOKEN", "replies after 15 minutes fail"],
    ["REPLY_TTL_MINUTES", String(DEFAULT_REPLY_TTL_MINUTES)],
  ];
  const pad = (s: string) => s.padEnd(30);
  const lines = [
    problems.size === 0 ? "grokbot-discord is running and configured." : "grokbot-discord is running but not configured.",
    "",
    "Required:",
    ...required.map((n) => `  ${pad(n)}${problems.has(n) ? problems.get(n) : "ok"}`),
    "",
    "Optional:",
    ...optional.map(([n, dflt]) =>
      `  ${pad(n)}${problems.has(n) ? problems.get(n) : env[n] !== undefined && env[n] !== "" ? "set" : `not set (default: ${dflt})`}`),
    "",
    "Point your Discord app's Interactions Endpoint URL at this address.",
    `Setup: ${README_URL}`,
    "",
  ];
  return new Response(lines.join("\n"), {
    status: problems.size === 0 ? 200 : 503,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/**
 * Discord signs `timestamp + body` with the application's Ed25519 key.
 * Returns false on any missing header, malformed hex or failed verification.
 */
export async function verifyDiscordRequest(
  body: string,
  signature: string | null,
  timestamp: string | null,
  publicKeyHex: string | undefined,
): Promise<boolean> {
  if (!signature || !timestamp || !publicKeyHex) return false;
  const sig = hexToBytes(signature);
  const key = hexToBytes(publicKeyHex.trim());
  if (!sig || sig.length !== 64 || !key || key.length !== 32) return false;
  try {
    const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", cryptoKey, sig, new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

/**
 * Returns why the user, server or channel isn't allowed, or null if it is.
 * Fails closed: an empty ALLOWED_USER_IDS allows nobody.
 */
export const DEFAULT_DENIED_MESSAGE =
  "You aren't allowed to use this bot.";

/** A first line, then a small `-#` hint line telling the bot's owner how to allow it. */
function denial(line: string, hint: string): string {
  return `${line}\n-# ${hint}`;
}

export function rejectionMessage(interaction: Interaction, env: Env): string | null {
  const userId = (interaction.member?.user ?? interaction.user)?.id ?? "unknown";
  if (!parseList(env.ALLOWED_USER_IDS).includes(userId)) {
    const line = (env.DENIED_MESSAGE ?? "").trim() || DEFAULT_DENIED_MESSAGE;
    return denial(line, `Your Discord user ID is \`${userId}\`. If you run this bot, add it to \`ALLOWED_USER_IDS\`.`);
  }
  // Only allowed users get past this point, so these messages speak to the owner.
  const guilds = parseList(env.ALLOWED_GUILD_IDS);
  if (guilds.length > 0 && !guilds.includes(interaction.guild_id ?? "")) {
    return interaction.guild_id
      ? denial("This bot isn't allowed in this server.", `The server ID is \`${interaction.guild_id}\`. To allow it, add it to \`ALLOWED_GUILD_IDS\`.`)
      : denial("This bot isn't allowed in direct messages.", "`ALLOWED_GUILD_IDS` is set. Use it in an allowed server, or empty `ALLOWED_GUILD_IDS`.");
  }
  const channels = parseList(env.ALLOWED_CHANNEL_IDS);
  const channelId = interaction.channel_id ?? interaction.channel?.id ?? "unknown";
  if (channels.length > 0 && !channels.includes(channelId)) {
    return denial("This bot isn't allowed in this channel.", `The channel ID is \`${channelId}\`. To allow it, add it to \`ALLOWED_CHANNEL_IDS\`.`);
  }
  return null;
}

export async function buildPayload(interaction: Interaction, env: Env, origin: string, now: Date = new Date()): Promise<WebhookPayload> {
  const user = (interaction.member?.user ?? interaction.user) as DiscordUser;
  const options: Record<string, string | number | boolean> = {};
  const path: string[] = [];
  flattenOptions(interaction.data?.options ?? [], options, path);
  const command = [interaction.data?.name ?? "", ...path].join(" ").trim();
  const text = "prompt" in options
    ? String(options.prompt)
    : Object.entries(options).map(([k, v]) => `${k}: ${v}`).join("\n");
  const channelId = interaction.channel_id ?? interaction.channel?.id ?? null;
  const receivedAt = now.getTime();
  const expiresAt = receivedAt + (replyTtlMinutes(env) ?? DEFAULT_REPLY_TTL_MINUTES) * 60_000;
  const ref = await sealRef(
    { a: interaction.application_id, t: interaction.token, c: channelId, g: interaction.guild_id ?? null, u: user.id, i: interaction.id, r: receivedAt, e: expiresAt },
    env.GROKBOT_WEBHOOK_KEY ?? "",
  );
  return {
    source: "discord",
    application_id: interaction.application_id,
    interaction_id: interaction.id,
    guild_id: interaction.guild_id ?? null,
    channel_id: channelId,
    user: { id: user.id, username: user.username ?? null, global_name: user.global_name ?? null },
    command,
    options,
    text,
    received_at: now.toISOString(),
    reply: {
      url: `${origin}/reply/${ref}`,
      method: "POST",
      body: { content: "<your answer in Markdown, any length>" },
      expires_at: new Date(expiresAt).toISOString(),
      instructions: REPLY_INSTRUCTIONS,
    },
  };
}

// Subcommands (type 1) and subcommand groups (type 2) become part of the command path.
function flattenOptions(opts: CommandOption[], out: Record<string, string | number | boolean>, path: string[]): void {
  for (const o of opts) {
    if (o.type === 1 || o.type === 2) {
      path.push(o.name);
      flattenOptions(o.options ?? [], out, path);
    } else if (o.value !== undefined) {
      out[o.name] = o.value;
    }
  }
}

/** The only place that knows how the routine webhook expects its key: `Authorization: Bearer <key>`. */
export function webhookAuthHeaders(env: Env): Record<string, string> {
  return { Authorization: `Bearer ${(env.GROKBOT_WEBHOOK_KEY ?? "").trim()}` };
}

/** Turns a failed webhook response into a message an installer can act on. */
export function describeWebhookFailure(status: number, body: string): string {
  const snippet = body ? ` Response: ${body.slice(0, 200)}` : "";
  if (status === 401 || status === 403) {
    return `The webhook rejected the key (HTTP ${status}). Check GROKBOT_WEBHOOK_KEY. ${SET_KEY_HINT}${snippet}`;
  }
  if (status === 404) {
    return `The webhook URL was not found (HTTP 404). Check GROKBOT_WEBHOOK_URL. ${SET_VARS_HINT}${snippet}`;
  }
  if (status === 429) return `The webhook is rate limiting requests (HTTP 429). Wait a minute and try again.${snippet}`;
  if (status >= 500) return `The webhook had a server error (HTTP ${status}). Try again later.${snippet}`;
  return `The webhook returned HTTP ${status}.${snippet}`;
}

/**
 * POSTs the payload to the routine webhook. On success Discord keeps showing "thinking"
 * until the bot replies. On failure the deferred message is edited to say what went wrong.
 * Logs one line per forward, never the key.
 */
export async function forward(payload: WebhookPayload, env: Env, interaction: Interaction): Promise<void> {
  const tag = `[forward ${payload.interaction_id}]`;
  let failure: string | null = null;
  try {
    const res = await fetch((env.GROKBOT_WEBHOOK_URL ?? "").trim(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...webhookAuthHeaders(env) },
      body: JSON.stringify(payload),
    });
    const text = await res.text().catch(() => "");
    console.log(`${tag} status=${res.status} body=${JSON.stringify(text.slice(0, 200))}`);
    if (!res.ok) failure = describeWebhookFailure(res.status, text);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.log(`${tag} status=error error=${JSON.stringify(reason)}`);
    failure = `Could not reach the webhook (${reason}). Check GROKBOT_WEBHOOK_URL.`;
  }
  if (failure) {
    const res = await discordFetch(
      "PATCH",
      `${interactionWebhookUrl(interaction.application_id, interaction.token)}/messages/@original`,
      { content: `Could not reach the bot. ${failure} Help: ${TROUBLESHOOTING_URL}`.slice(0, MAX_MESSAGE_LENGTH), allowed_mentions: { parse: [] } },
    );
    if (!res.ok) console.log(`${tag} discord edit failed ${describeDiscordError(res)}`);
  }
}

// ---------------------------------------------------------------------------
// Replies: POST /reply/<ref>
//
// The reply URL is a capability. <ref> is the interaction (application id, token, channel,
// user, times) encrypted with AES-GCM under a key derived from GROKBOT_WEBHOOK_KEY. Only this
// Worker can create or read one, any change makes it fail authentication, and it only lets
// you post to that one interaction, the same power Discord's own interaction webhook URL gives.
// ---------------------------------------------------------------------------

export function replyTtlMinutes(env: Env): number | null {
  const raw = (env.REPLY_TTL_MINUTES ?? "").trim();
  if (!raw) return DEFAULT_REPLY_TTL_MINUTES;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 10080 ? n : null;
}

const encoder = new TextEncoder();
const refKeys = new Map<string, Promise<CryptoKey>>();

function refKey(secret: string): Promise<CryptoKey> {
  let key = refKeys.get(secret);
  if (!key) {
    key = (async () => {
      const base = await crypto.subtle.importKey("raw", encoder.encode(secret.trim()), "HKDF", false, ["deriveKey"]);
      return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: encoder.encode("grokbot-discord"), info: encoder.encode("reply-ref-v1") },
        base,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    refKeys.set(secret, key);
  }
  return key;
}

const REF_VERSION = 1;

export async function sealRef(ref: ReplyRef, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new Uint8Array([REF_VERSION]) }, await refKey(secret), encoder.encode(JSON.stringify(ref))),
  );
  const out = new Uint8Array(1 + iv.length + sealed.length);
  out[0] = REF_VERSION;
  out.set(iv, 1);
  out.set(sealed, 1 + iv.length);
  return base64UrlEncode(out);
}

/** Returns null for anything this Worker didn't create with the current key. GCM checks the tag in constant time. */
export async function openRef(token: string, secret: string): Promise<ReplyRef | null> {
  const bytes = base64UrlDecode(token);
  if (!bytes || bytes.length < 1 + 12 + 16 || bytes[0] !== REF_VERSION) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(1, 13), additionalData: new Uint8Array([REF_VERSION]) },
      await refKey(secret),
      bytes.slice(13),
    );
    const ref = JSON.parse(new TextDecoder().decode(plain)) as ReplyRef;
    return typeof ref.a === "string" && typeof ref.t === "string" && typeof ref.u === "string" && typeof ref.e === "number" ? ref : null;
  } catch {
    return null;
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function interactionWebhookUrl(applicationId: string, token: string): string {
  return `${DISCORD_API}/webhooks/${applicationId}/${token}`;
}

/**
 * Splits text into messages of at most `limit` characters. Prefers paragraph, then line, then
 * word boundaries. A code block cut in two is closed and reopened with the same language.
 */
export function splitMessage(text: string, limit = MAX_MESSAGE_LENGTH): string[] {
  const chunks: string[] = [];
  let rest = text;
  let fence: string | null = null;
  while (rest.length > 0) {
    const prefix = fence ? `${fence}\n` : "";
    if (prefix.length + rest.length <= limit) {
      chunks.push(prefix + rest);
      break;
    }
    const budget = limit - prefix.length - 4; // room for "\n```"
    const window = rest.slice(0, budget);
    let cut = budget;
    let skip = 0;
    for (const sep of ["\n\n", "\n", " "]) {
      const at = window.lastIndexOf(sep);
      if (at > budget / 2) {
        cut = at;
        skip = sep.length;
        break;
      }
    }
    if (skip === 0 && /[\uD800-\uDBFF]/.test(rest[cut - 1] ?? "")) cut -= 1; // don't split a surrogate pair
    let chunk = prefix + rest.slice(0, cut);
    rest = rest.slice(cut + skip).replace(/^\n+/, ""); // no blank lines at the top of a message
    fence = openFenceAtEnd(chunk);
    if (fence) chunk += "\n```";
    if (chunk.trim()) chunks.push(chunk);
  }
  return chunks;
}

/** The opening line (e.g. "```ts") of a code block left open at the end of `text`, or null. */
function openFenceAtEnd(text: string): string | null {
  let open: string | null = null;
  for (const line of text.split("\n")) {
    const m = /^\s*(```\S*)/.exec(line);
    if (m) open = open ? null : m[1];
  }
  return open;
}

interface DiscordResult {
  ok: boolean;
  status: number; // 0 when Discord could not be reached
  code?: number;
  message?: string;
  data?: { id?: string };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One Discord API call. Retries once on a short rate limit. Never logs or returns the token. */
async function discordFetch(method: string, url: string, body: unknown, botToken?: string): Promise<DiscordResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (botToken) headers.Authorization = `Bot ${botToken}`;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body: JSON.stringify(body) });
    } catch (e) {
      return { ok: false, status: 0, message: e instanceof Error ? e.message : String(e) };
    }
    const text = await res.text().catch(() => "");
    let data: Record<string, unknown> = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { message: text.slice(0, 200) };
    }
    if (res.status === 429 && attempt === 0) {
      const wait = Number(data.retry_after ?? res.headers.get("Retry-After") ?? 1);
      if (wait <= 5) {
        await sleep(Math.max(wait, 0) * 1000 + 100);
        continue;
      }
    }
    if (res.ok) return { ok: true, status: res.status, data: data as { id?: string } };
    return {
      ok: false,
      status: res.status,
      code: typeof data.code === "number" ? data.code : undefined,
      message: typeof data.message === "string" ? data.message : text.slice(0, 200) || res.statusText,
    };
  }
}

function describeDiscordError(r: DiscordResult): string {
  if (r.status === 0) return `could not reach Discord (${r.message})`;
  return `HTTP ${r.status}${r.code !== undefined ? ` code ${r.code}` : ""}: ${r.message ?? ""}`.trim();
}

// Discord error codes
const UNKNOWN_MESSAGE = 10008;
const UNKNOWN_WEBHOOK = 10015;
const INVALID_WEBHOOK_TOKEN = 50027;
const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;

const tokenExpired = (r: DiscordResult) =>
  r.code === INVALID_WEBHOOK_TOKEN || r.code === UNKNOWN_WEBHOOK || (r.status === 401 && r.code === undefined);

function botFailureHint(r: DiscordResult): string {
  if (r.status === 401) return "Discord rejected DISCORD_BOT_TOKEN. Copy a fresh token from Bot > Reset Token and set it again as a secret.";
  if (r.code === MISSING_ACCESS || r.code === MISSING_PERMISSIONS || r.status === 403) {
    return "The bot can't post in this channel. Install the app with the `bot` scope and give it View Channel and Send Messages there.";
  }
  if (r.status === 0) return "Try again in a moment.";
  return "See Discord's message for details.";
}

interface ReplyError {
  status: number;
  error: string;
  message: string;
  discord?: DiscordResult;
  sent?: number;
}

function replyError(e: ReplyError): Response {
  const body: Record<string, unknown> = { ok: false, error: e.error, message: e.message };
  if (e.discord) body.discord = { status: e.discord.status, code: e.discord.code ?? null, message: e.discord.message ?? null };
  if (e.sent !== undefined) body.messages_sent = e.sent;
  body.help = `${TROUBLESHOOTING_URL}`;
  return json(body, e.status);
}

const MAX_BODY_BYTES = 100_000;

async function readReplyBody(request: Request): Promise<{ content: string; progress: boolean } | ReplyError> {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return { status: 413, error: "body_too_large", message: `The request body is larger than ${MAX_BODY_BYTES} bytes.` };
  }
  const type = (request.headers.get("Content-Type") ?? "").toLowerCase();
  let content: unknown;
  let progress: unknown = false;
  if (type.startsWith("text/plain")) {
    content = raw;
  } else {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return { status: 400, error: "invalid_json", message: 'The body is not valid JSON. Send {"content": "your answer"} with Content-Type: application/json.' };
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return { status: 400, error: "invalid_body", message: 'The body must be a JSON object like {"content": "your answer"}.' };
    }
    ({ content, progress = false } = body as { content?: unknown; progress?: unknown });
  }
  if (typeof content !== "string") {
    return { status: 400, error: "missing_content", message: '"content" is required and must be a string.' };
  }
  if (!content.trim()) return { status: 400, error: "empty_content", message: '"content" is empty.' };
  if (typeof progress !== "boolean") return { status: 400, error: "invalid_progress", message: '"progress" must be true or false.' };
  if (content.length > MAX_REPLY_LENGTH) {
    return {
      status: 413,
      error: "content_too_long",
      message: `"content" is ${content.length} characters. The limit is ${MAX_REPLY_LENGTH} (10 Discord messages). Shorten the answer.`,
    };
  }
  return { content, progress };
}

export async function handleReply(request: Request, url: URL, env: Env, now: number = Date.now()): Promise<Response> {
  if (request.method !== "POST") {
    const res = replyError({ status: 405, error: "method_not_allowed", message: "Use POST with a JSON body like {\"content\": \"your answer\"}." });
    res.headers.set("Allow", "POST");
    return res;
  }
  const secret = (env.GROKBOT_WEBHOOK_KEY ?? "").trim();
  if (!secret) {
    return replyError({ status: 500, error: "worker_misconfigured", message: `GROKBOT_WEBHOOK_KEY is missing on the Worker, so it can't read reply URLs. ${SET_KEY_HINT}` });
  }
  const token = url.pathname.slice("/reply/".length);
  if (!token) {
    return replyError({ status: 400, error: "missing_ref", message: "The reply URL is incomplete. Use the full reply.url from the payload, including the part after /reply/." });
  }
  const ref = await openRef(token, secret);
  if (!ref) {
    console.log("[reply] status=403 reason=invalid_reply_url");
    return replyError({
      status: 403,
      error: "invalid_reply_url",
      message: "This reply URL is not valid. It was changed or cut short, or it was created before GROKBOT_WEBHOOK_KEY changed. Use reply.url from the payload exactly as received.",
    });
  }
  const tag = `[reply ${ref.i}]`;
  if (now > ref.e) {
    console.log(`${tag} status=410 reason=reply_url_expired`);
    return replyError({
      status: 410,
      error: "reply_url_expired",
      message: `This reply URL expired at ${new Date(ref.e).toISOString()}. Raise REPLY_TTL_MINUTES if answers take longer.`,
    });
  }
  const body = await readReplyBody(request);
  if ("error" in body) {
    console.log(`${tag} status=${body.status} reason=${body.error}`);
    return replyError(body);
  }

  const result = now < ref.r + INTERACTION_TOKEN_TTL_MS ? await replyToInteraction(ref, body.content) : null;
  if (result && !("expired" in result)) return finish(tag, result);

  // The interaction token has expired: fall back to a channel message from the bot.
  if (body.progress) {
    console.log(`${tag} status=200 skipped progress note after token expiry`);
    return json({ ok: true, via: "none", messages: 0, note: "Progress note not posted: the interaction expired after 15 minutes. Post the final answer." });
  }
  const botToken = (env.DISCORD_BOT_TOKEN ?? "").trim();
  if (!botToken) {
    console.log(`${tag} status=410 reason=interaction_expired`);
    return replyError({
      status: 410,
      error: "interaction_expired",
      message: (result
        ? `Discord no longer accepts this interaction's token (${describeDiscordError(result.discord)}). Tokens expire 15 minutes after the command.`
        : "Discord's interaction token expired 15 minutes after the command.") +
        " DISCORD_BOT_TOKEN isn't set, so the Worker can't post the reply in the channel instead. Set DISCORD_BOT_TOKEN as a secret to allow late replies.",
      discord: result?.discord,
    });
  }
  return finish(tag, await replyInChannel(ref, body.content, botToken));
}

type SendResult = { via: "interaction" | "channel"; messages: number; ids: string[] } | ReplyError;

function finish(tag: string, r: SendResult): Response {
  if ("error" in r) {
    console.log(`${tag} status=${r.status} reason=${r.error}${r.discord ? ` discord=${JSON.stringify(describeDiscordError(r.discord))}` : ""}`);
    return replyError(r);
  }
  console.log(`${tag} status=200 via=${r.via} messages=${r.messages}`);
  return json({ ok: true, via: r.via, messages: r.messages, message_ids: r.ids });
}

/** Replaces the deferred "thinking" message with the first part and posts the rest as follow-ups. */
async function replyToInteraction(ref: ReplyRef, content: string): Promise<SendResult | { expired: true; discord: DiscordResult }> {
  const hook = interactionWebhookUrl(ref.a, ref.t);
  const chunks = splitMessage(content);
  const ids: string[] = [];
  for (let n = 0; n < chunks.length; n++) {
    const message = { content: chunks[n], allowed_mentions: { parse: [] } };
    let r = n === 0 ? await discordFetch("PATCH", `${hook}/messages/@original`, message) : await discordFetch("POST", `${hook}?wait=true`, message);
    // The "thinking" message was deleted: post the first part as a follow-up instead.
    if (n === 0 && !r.ok && r.code === UNKNOWN_MESSAGE) r = await discordFetch("POST", `${hook}?wait=true`, message);
    if (!r.ok) {
      if (n === 0 && tokenExpired(r)) return { expired: true, discord: r };
      return {
        status: 502,
        error: "discord_error",
        message: `Discord rejected message ${n + 1} of ${chunks.length} (${describeDiscordError(r)}).`,
        discord: r,
        sent: n,
      };
    }
    if (r.data?.id) ids.push(r.data.id);
  }
  return { via: "interaction", messages: chunks.length, ids };
}

/** Posts in the original channel (or a DM) with the bot token, mentioning the user on the first message. */
async function replyInChannel(ref: ReplyRef, content: string, botToken: string): Promise<SendResult> {
  let channelId = ref.c;
  if (!ref.g) {
    const dm = await discordFetch("POST", `${DISCORD_API}/users/@me/channels`, { recipient_id: ref.u }, botToken);
    if (!dm.ok || !dm.data?.id) {
      return { status: 502, error: "discord_error", message: `Could not open a DM with the user (${describeDiscordError(dm)}). ${botFailureHint(dm)}`, discord: dm, sent: 0 };
    }
    channelId = dm.data.id;
  }
  if (!channelId) return { status: 400, error: "no_channel", message: "The interaction has no channel to post in." };
  const mention = `<@${ref.u}> `;
  const chunks = splitMessage(content, MAX_MESSAGE_LENGTH - mention.length);
  const ids: string[] = [];
  for (let n = 0; n < chunks.length; n++) {
    const message = n === 0
      ? { content: mention + chunks[n], allowed_mentions: { users: [ref.u] } }
      : { content: chunks[n], allowed_mentions: { parse: [] } };
    const r = await discordFetch("POST", `${DISCORD_API}/channels/${channelId}/messages`, message, botToken);
    if (!r.ok) {
      return {
        status: 502,
        error: "discord_error",
        message: `The interaction expired, and posting in the channel with DISCORD_BOT_TOKEN failed on message ${n + 1} of ${chunks.length} (${describeDiscordError(r)}). ${botFailureHint(r)}`,
        discord: r,
        sent: n,
      };
    }
    if (r.data?.id) ids.push(r.data.id);
  }
  return { via: "channel", messages: chunks.length, ids };
}

function parseList(value: string | undefined): string[] {
  return (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function ephemeral(content: string): Response {
  return json({
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: content.slice(0, 2000), flags: EPHEMERAL, allowed_mentions: { parse: [] } },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
