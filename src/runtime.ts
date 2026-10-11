import { config } from './config.js';
import { openDb, migrate } from './db/index.js';
import type { Ctx } from './game/ctx.js';
import { tick } from './game/world.js';
import { log } from './logger.js';

/** Open + migrate the database and build the shared game context. */
export function bootstrap(): Ctx {
  const db = openDb(config.dbPath);
  const applied = migrate(db);
  if (applied.length) log.info(`[db] applied migrations: ${applied.join(', ')}`);
  log.info(`[db] ${config.dbPath} ready (${(db.prepare('SELECT COUNT(*) n FROM players').get() as any).n} players)`);
  return { db, now: () => Date.now() };
}

/** Background world simulation. Idempotent, so running it in several processes is safe. */
export function startTicker(ctx: Ctx): NodeJS.Timeout {
  const run = () => { try { tick(ctx, true); } catch (e) { log.error(`[tick] failed: ${(e as Error).stack ?? e}`); } };
  run();
  return setInterval(run, config.tickSeconds * 1000);
}
