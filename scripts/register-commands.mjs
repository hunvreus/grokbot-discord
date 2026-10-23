#!/usr/bin/env node
// Registers (or updates) the slash command for your Discord application.
//
// Required env:
//   DISCORD_APPLICATION_ID  General Information > Application ID
//   DISCORD_BOT_TOKEN       Bot > Reset Token (only used here; the Worker uses it only if you also set it there)
// Optional env:
//   DISCORD_GUILD_ID        register in one server (appears instantly) instead of globally (up to an hour)
//   COMMAND_NAME            default "ask"; 1-32 characters of a-z, 0-9, - or _
//   COMMAND_DESCRIPTION     default "Send a request to the bot"; 1-100 characters
//
// The token is never printed.

const appId = (process.env.DISCORD_APPLICATION_ID ?? "").trim();
const token = (process.env.DISCORD_BOT_TOKEN ?? "").trim();
const guildId = (process.env.DISCORD_GUILD_ID ?? "").trim();
const name = process.env.COMMAND_NAME ?? "ask";
const description = process.env.COMMAND_DESCRIPTION ?? "Send a request to the bot";

const errors = [];
if (!appId) errors.push("DISCORD_APPLICATION_ID is missing. Copy Application ID from General Information in the Developer Portal.");
else if (!/^\d{17,20}$/.test(appId)) errors.push("DISCORD_APPLICATION_ID should be a 17-20 digit number.");
if (!token) errors.push("DISCORD_BOT_TOKEN is missing. Create one under Bot > Reset Token in the Developer Portal.");
if (guildId && !/^\d{17,20}$/.test(guildId)) errors.push("DISCORD_GUILD_ID should be a 17-20 digit server id, or unset to register globally.");
if (!/^[-_a-z0-9]{1,32}$/.test(name)) {
  errors.push(`COMMAND_NAME "${name}" is invalid. Use 1-32 characters: lowercase a-z, 0-9, - or _.`);
}
if (description.length < 1 || description.length > 100) errors.push("COMMAND_DESCRIPTION must be 1-100 characters.");
if (errors.length > 0) {
  for (const e of errors) console.error(`Error: ${e}`);
  console.error("\nExample: DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... npm run register");
  process.exit(1);
}

const command = {
  name,
  description,
  type: 1, // CHAT_INPUT
  options: [{ type: 3, name: "prompt", description: "What you want the bot to do", required: true }],
};

const base = `https://discord.com/api/v10/applications/${appId}`;
const url = guildId ? `${base}/guilds/${guildId}/commands` : `${base}/commands`;

let res;
try {
  // POST creates the command, or updates it if one with the same name exists.
  res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
} catch (e) {
  console.error(`Error: could not reach Discord (${e instanceof Error ? e.message : e}).`);
  process.exit(1);
}

if (!res.ok) {
  const body = (await res.text()).slice(0, 500);
  const hints = {
    401: "DISCORD_BOT_TOKEN was rejected. Reset it under Bot in the Developer Portal and try again.",
    403: "The app can't register commands there. Check that it is installed in that server with the applications.commands scope.",
    404: "Unknown application or server. Check DISCORD_APPLICATION_ID and DISCORD_GUILD_ID.",
    429: "Rate limited by Discord. Wait a minute and try again.",
  };
  console.error(`Error: Discord returned HTTP ${res.status}. ${hints[res.status] ?? ""}`.trim());
  console.error(`Response: ${body}`);
  process.exit(1);
}

const created = await res.json();
console.log(`Registered /${created.name} (id ${created.id}) ${guildId ? `in server ${guildId}` : "globally"}.`);
if (!guildId) console.log("Global commands can take up to an hour to appear. Set DISCORD_GUILD_ID to register in one server instantly.");
