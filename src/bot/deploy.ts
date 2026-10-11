import { REST, Routes } from 'discord.js';
import { config } from '../config.js';
import { commandJson } from './commands.js';

if (!config.discordToken || !config.discordClientId) throw new Error('Set DISCORD_TOKEN and DISCORD_CLIENT_ID');
const rest = new REST().setToken(config.discordToken);
const body = commandJson();
const route = config.discordGuildId ? Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId) : Routes.applicationCommands(config.discordClientId);
await rest.put(route, { body });
console.log(`Registered ${body.length} slash commands ${config.discordGuildId ? `to guild ${config.discordGuildId}` : 'globally (can take up to an hour to appear)'}.`);
