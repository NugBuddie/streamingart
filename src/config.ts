import 'dotenv/config';

export const config = {
  discordToken: process.env.DISCORD_TOKEN ?? '',
  discordClientId: process.env.DISCORD_CLIENT_ID ?? '',
  discordGuildId: process.env.DISCORD_GUILD_ID ?? '',
  dbPath: process.env.DB_PATH ?? './data/void.db',
  webPort: Number(process.env.WEB_PORT ?? 3000),
  webDevLogin: process.env.WEB_DEV_LOGIN === '1',
  tickSeconds: Number(process.env.TICK_SECONDS ?? 5),
  /** Mission durations are 5/15/30 of this unit. 'seconds' = fast testing mode, 'minutes' = real game pace. */
  missionUnit: (process.env.MISSION_TIME_UNIT ?? 'seconds') === 'minutes' ? 'minutes' : 'seconds',
  missionUnitMs: (process.env.MISSION_TIME_UNIT ?? 'seconds') === 'minutes' ? 60_000 : 1_000,
};
