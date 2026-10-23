#!/usr/bin/env node
// Registers (or updates) one slash command for the Discord application.
// Env: DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN, optional DISCORD_GUILD_ID,
// COMMAND_NAME (default "ask"), COMMAND_DESCRIPTION.
// Never prints the token.

const appId = process.env.DISCORD_APPLICATION_ID;
const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
const name = (process.env.COMMAND_NAME || "ask").toLowerCase();
const description = process.env.COMMAND_DESCRIPTION || "Send a message to the bot";

if (!appId || !token) {
  console.error("Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN.");
  process.exit(1);
}
if (!/^[-_\p{L}\p{N}]{1,32}$/u.test(name)) {
  console.error(`Invalid COMMAND_NAME "${name}": use 1-32 lowercase letters, digits, - or _.`);
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

// POST creates the command, or updates it if one with the same name exists.
const res = await fetch(url, {
  method: "POST",
  headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(command),
});

if (!res.ok) {
  console.error(`Discord returned HTTP ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const created = await res.json();
console.log(`Registered /${created.name} (id ${created.id}) ${guildId ? `in guild ${guildId}` : "globally"}.`);
if (!guildId) console.log("Global commands can take up to an hour to appear. Set DISCORD_GUILD_ID for instant updates.");
