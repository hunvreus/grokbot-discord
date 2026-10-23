/**
 * grokbot-discord: relays Discord slash commands to a Grok Bot routine webhook.
 */

export interface Env {
  DISCORD_PUBLIC_KEY: string;
  ALLOWED_USER_IDS: string;
  ALLOWED_GUILD_IDS?: string;
  ALLOWED_CHANNEL_IDS?: string;
  GROKBOT_WEBHOOK_URL: string;
  GROKBOT_WEBHOOK_KEY: string;
  GROKBOT_WEBHOOK_AUTH_HEADER?: string;
  GROKBOT_WEBHOOK_AUTH_SCHEME?: string;
}

const DISCORD_API = "https://discord.com/api/v10";

// Interaction types
const PING = 1;
const APPLICATION_COMMAND = 2;

// Interaction callback types
const PONG = 1;
const CHANNEL_MESSAGE_WITH_SOURCE = 4;
const DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5;

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

interface Interaction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  guild_id?: string;
  channel_id?: string;
  channel?: { id: string };
  member?: { user: DiscordUser };
  user?: DiscordUser;
  data?: { name: string; options?: CommandOption[] };
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
    if (request.method === "GET" && new URL(request.url).pathname === "/_diag") {
      return json(await secretFingerprints(env));
    }
    if (request.method !== "POST") {
      return new Response("grokbot-discord is running. Point Discord's Interactions Endpoint URL here.", {
        status: request.method === "GET" ? 200 : 405,
      });
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
      return new Response("Unsupported interaction type.", { status: 400 });
    }

    if (!isAllowed(interaction, env)) {
      return json({ type: CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "Not allowed.", flags: EPHEMERAL } });
    }

    const payload = buildPayload(interaction);
    ctx.waitUntil(forward(payload, env));
    return json({ type: DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
  },
};

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
  const key = hexToBytes(publicKeyHex);
  if (!sig || sig.length !== 64 || !key || key.length !== 32) return false;
  try {
    const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", cryptoKey, sig, new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

/** Fails closed: an empty ALLOWED_USER_IDS allows nobody. */
export function isAllowed(interaction: Interaction, env: Env): boolean {
  const users = parseList(env.ALLOWED_USER_IDS);
  const userId = (interaction.member?.user ?? interaction.user)?.id;
  if (users.length === 0 || !userId || !users.includes(userId)) return false;

  const guilds = parseList(env.ALLOWED_GUILD_IDS);
  if (guilds.length > 0 && (!interaction.guild_id || !guilds.includes(interaction.guild_id))) return false;

  const channels = parseList(env.ALLOWED_CHANNEL_IDS);
  const channelId = interaction.channel_id ?? interaction.channel?.id;
  if (channels.length > 0 && (!channelId || !channels.includes(channelId))) return false;

  return true;
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
  const followup = `${DISCORD_API}/webhooks/${interaction.application_id}/${interaction.token}`;
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
    followup_url: followup,
    edit_original_url: `${followup}/messages/@original`,
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
  return { [header]: scheme ? `${scheme} ${env.GROKBOT_WEBHOOK_KEY}` : env.GROKBOT_WEBHOOK_KEY };
}

/**
 * Non-reversible fingerprints (first 12 hex of SHA-256) and lengths of the webhook settings,
 * so the deployed values can be compared with the box's without ever exposing them.
 */
export async function secretFingerprints(env: Env): Promise<Record<string, string | number>> {
  const auth = Object.values(webhookAuthHeaders(env))[0];
  return {
    key_len: (env.GROKBOT_WEBHOOK_KEY ?? "").length,
    key_sha12: await sha12(env.GROKBOT_WEBHOOK_KEY ?? ""),
    auth_header: Object.keys(webhookAuthHeaders(env))[0],
    auth_sha12: await sha12(auth),
    url_len: (env.GROKBOT_WEBHOOK_URL ?? "").length,
    url_sha12: await sha12(env.GROKBOT_WEBHOOK_URL ?? ""),
  };
}

async function sha12(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

export async function forward(payload: WebhookPayload, env: Env): Promise<void> {
  const tag = `[forward ${payload.interaction_id}]`;
  console.log(`${tag} sending ${JSON.stringify(await secretFingerprints(env))}`);
  let error: string | null = null;
  try {
    const res = await fetch(env.GROKBOT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...webhookAuthHeaders(env) },
      body: JSON.stringify(payload),
    });
    const text = await res.text().catch(() => "");
    // Never log the key or the request; only the webhook's answer.
    console.log(`${tag} webhook status=${res.status} body=${JSON.stringify(text.slice(0, 300))}`);
    if (!res.ok) error = `the webhook returned HTTP ${res.status}${text ? ` (${text.slice(0, 200)})` : ""}`;
  } catch (e) {
    console.log(`${tag} webhook fetch threw: ${e instanceof Error ? e.message : String(e)}`);
    error = "the webhook could not be reached";
  }

  // Replace Discord's "thinking..." state either way, so the user can see where things stand.
  // The bot's own reply later edits the same message.
  const content = error === null ? "Sent to Grug." : `Could not reach the bot: ${error}.`;
  await patchOriginal(payload.edit_original_url, content, tag);
}

async function patchOriginal(url: string, content: string, tag: string): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: content.slice(0, 2000) }),
    });
    const text = res.ok ? "" : await res.text().catch(() => "");
    console.log(`${tag} discord patch status=${res.status}${text ? ` body=${JSON.stringify(text.slice(0, 300))}` : ""}`);
  } catch (e) {
    console.log(`${tag} discord patch threw: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function parseList(value: string | undefined): string[] {
  return (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
