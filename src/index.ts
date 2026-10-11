/** All-in-one entry: world ticker + web server + Discord bot (bot is skipped when DISCORD_TOKEN is unset). */
import { config } from './config.js';
import { bootstrap, startTicker } from './runtime.js';
import { startWeb } from './web/server.js';
import { startBot } from './bot/index.js';

const ctx = bootstrap();
startTicker(ctx);
startWeb(ctx);
if (config.discordToken) await startBot(ctx);
else console.log('[bot] DISCORD_TOKEN not set — running web only.');

process.on('unhandledRejection', (e) => console.error('[fatal] unhandled rejection', e));
