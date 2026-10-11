import 'dotenv/config';

export const config = {
  discordToken: process.env.DISCORD_TOKEN ?? '',
  discordClientId: process.env.DISCORD_CLIENT_ID ?? '',
  discordGuildId: process.env.DISCORD_GUILD_ID ?? '',
  dbPath: process.env.DB_PATH ?? './data/void.db',
  webPort: Number(process.env.WEB_PORT ?? 3000),
  webDevLogin: process.env.WEB_DEV_LOGIN === '1',
  tickSeconds: Number(process.env.TICK_SECONDS ?? 30),
};
