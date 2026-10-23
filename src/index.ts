/**
 * grokbot-discord: relays Discord slash commands to a Grok Bot routine webhook.
 * Setup and troubleshooting: see README.md.
 */

export interface Env {
  DISCORD_PUBLIC_KEY?: string;
  ALLOWED_USER_IDS?: string;
  ALLOWED_GUILD_IDS?: string;
  ALLOWED_CHANNEL_IDS?: string;
  GROKBOT_WEBHOOK_URL?: string;
  GROKBOT_WEBHOOK_KEY?: string;
  GROKBOT_WEBHOOK_AUTH_HEADER?: string;
  GROKBOT_WEBHOOK_AUTH_SCHEME?: string;
}

export const README_URL = "https://github.com/hunvreus/grokbot-discord#readme";
const TROUBLESHOOTING_URL = "https://github.com/hunvreus/grokbot-discord#troubleshooting";
const DISCORD_API = "https://discord.com/api/v10";
const SET_SECRETS_HINT =
  "Set secrets in the Cloudflare dashboard (Worker > Settings > Variables and Secrets) or with `npx wrangler secret put <NAME>`, " +
  "and paste the value yourself: automated tools can mangle secrets.";

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

export interface WebhookPayload {
  source: "discord";
  application_id: string;
  interaction_id: string;
  interaction_token: string;
  guild_id: string | null;
  channel_id: string | null;
  user: { id: string; username: string | null; global_name: string | null };
  command: string;
  options: Record<string, string | number | boolean>;
  text: string;
  followup_url: string;
  edit_original_url: string;
  received_at: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
      return ephemeral(`The bot is not configured yet:\n${lines}\nSee ${README_URL}#configuration. ${SET_SECRETS_HINT}`);
    }

    const rejection = rejectionMessage(interaction, env);
    if (rejection) return ephemeral(rejection);

    const payload = buildPayload(interaction);
    if (!payload.text.trim()) return ephemeral(`/${payload.command} needs a prompt. Try \`/${payload.command} prompt: hello\`.`);

    ctx.waitUntil(forward(payload, env));
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
  return problems;
}

/** Plain-text page for a browser or curl. Lists setting names and whether they are set, never values. */
function statusPage(env: Env): Response {
  const problems = new Map(configProblems(env).map((p) => [p.name, p.problem]));
  const required: (keyof Env)[] = ["DISCORD_PUBLIC_KEY", "ALLOWED_USER_IDS", "GROKBOT_WEBHOOK_URL", "GROKBOT_WEBHOOK_KEY"];
  const optional: [keyof Env, string][] = [
    ["ALLOWED_GUILD_IDS", "any server"],
    ["ALLOWED_CHANNEL_IDS", "any channel"],
    ["GROKBOT_WEBHOOK_AUTH_HEADER", "Authorization"],
    ["GROKBOT_WEBHOOK_AUTH_SCHEME", "Bearer"],
  ];
  const pad = (s: string) => s.padEnd(30);
  const lines = [
    problems.size === 0 ? "grokbot-discord is running and configured." : "grokbot-discord is running but not configured.",
    "",
    "Required:",
    ...required.map((n) => `  ${pad(n)}${problems.has(n) ? problems.get(n) : "ok"}`),
    "",
    "Optional:",
    ...optional.map(([n, dflt]) => `  ${pad(n)}${env[n] !== undefined && env[n] !== "" ? "set" : `not set (default: ${dflt})`}`),
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
export function rejectionMessage(interaction: Interaction, env: Env): string | null {
  const userId = (interaction.member?.user ?? interaction.user)?.id ?? "unknown";
  if (!parseList(env.ALLOWED_USER_IDS).includes(userId)) {
    return `You aren't allowed to use this bot. To allow it, add user id ${userId} to ALLOWED_USER_IDS.`;
  }
  const guilds = parseList(env.ALLOWED_GUILD_IDS);
  if (guilds.length > 0 && !guilds.includes(interaction.guild_id ?? "")) {
    return interaction.guild_id
      ? `This bot isn't allowed in this server. To allow it, add server id ${interaction.guild_id} to ALLOWED_GUILD_IDS.`
      : "This bot isn't allowed in direct messages because ALLOWED_GUILD_IDS is set. Use it in an allowed server.";
  }
  const channels = parseList(env.ALLOWED_CHANNEL_IDS);
  const channelId = interaction.channel_id ?? interaction.channel?.id ?? "unknown";
  if (channels.length > 0 && !channels.includes(channelId)) {
    return `This bot isn't allowed in this channel. To allow it, add channel id ${channelId} to ALLOWED_CHANNEL_IDS.`;
  }
  return null;
}

export function buildPayload(interaction: Interaction, now: Date = new Date()): WebhookPayload {
  const user = (interaction.member?.user ?? interaction.user) as DiscordUser;
  const options: Record<string, string | number | boolean> = {};
  const path: string[] = [];
  flattenOptions(interaction.data?.options ?? [], options, path);
  const command = [interaction.data?.name ?? "", ...path].join(" ").trim();
  const text = "prompt" in options
    ? String(options.prompt)
    : Object.entries(options).map(([k, v]) => `${k}: ${v}`).join("\n");
  const followupUrl = `${DISCORD_API}/webhooks/${interaction.application_id}/${interaction.token}`;
  return {
    source: "discord",
    application_id: interaction.application_id,
    interaction_id: interaction.id,
    interaction_token: interaction.token,
    guild_id: interaction.guild_id ?? null,
    channel_id: interaction.channel_id ?? interaction.channel?.id ?? null,
    user: { id: user.id, username: user.username ?? null, global_name: user.global_name ?? null },
    command,
    options,
    text,
    followup_url: followupUrl,
    edit_original_url: `${followupUrl}/messages/@original`,
    received_at: now.toISOString(),
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

/** The only place that knows how the routine webhook expects its key. */
export function webhookAuthHeaders(env: Env): Record<string, string> {
  const header = env.GROKBOT_WEBHOOK_AUTH_HEADER || "Authorization";
  const scheme = env.GROKBOT_WEBHOOK_AUTH_SCHEME ?? "Bearer";
  const key = (env.GROKBOT_WEBHOOK_KEY ?? "").trim();
  return { [header]: scheme ? `${scheme} ${key}` : key };
}

/** Turns a failed webhook response into a message an installer can act on. */
export function describeWebhookFailure(status: number, body: string): string {
  const snippet = body ? ` Response: ${body.slice(0, 200)}` : "";
  if (status === 401 || status === 403) {
    return `The webhook rejected the key (HTTP ${status}). Check GROKBOT_WEBHOOK_KEY, GROKBOT_WEBHOOK_AUTH_HEADER and GROKBOT_WEBHOOK_AUTH_SCHEME. ${SET_SECRETS_HINT}${snippet}`;
  }
  if (status === 404) {
    return `The webhook URL was not found (HTTP 404). Check GROKBOT_WEBHOOK_URL. ${SET_SECRETS_HINT}${snippet}`;
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
export async function forward(payload: WebhookPayload, env: Env): Promise<void> {
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
  if (failure) await editOriginal(payload.edit_original_url, `Could not reach the bot. ${failure} Help: ${TROUBLESHOOTING_URL}`, tag);
}

async function editOriginal(url: string, content: string, tag: string): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: content.slice(0, 2000), allowed_mentions: { parse: [] } }),
    });
    if (!res.ok) console.log(`${tag} discord edit failed status=${res.status} body=${JSON.stringify((await res.text()).slice(0, 200))}`);
  } catch (e) {
    console.log(`${tag} discord edit failed error=${JSON.stringify(e instanceof Error ? e.message : String(e))}`);
  }
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
