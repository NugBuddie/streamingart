import { Database, type DB } from './sqlite.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CITIES } from '../data/world.js';

export type { DB };

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  return db;
}

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

/** Applies every unapplied migrations/NNN_*.sql in order, each inside its own transaction. */
export function migrate(db: DB): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const done = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r: any) => r.version));
  const applied: string[] = [];
  for (const f of fs.readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(f, Date.now());
    })();
    applied.push(f);
  }
  seedStatic(db);
  return applied;
}

/** Upserts code-defined content (cities) so SQL can join against it. Safe to run at every start. */
export function seedStatic(db: DB): void {
  const up = db.prepare(`INSERT INTO cities (id,name,region,archetype,danger,radiation,storm_factor,bandit_chance,monster_rate,merchant_chance)
    VALUES (@id,@name,@region,@archetype,@danger,@radiation,@stormFactor,@banditChance,@monsterRate,@merchantChance)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, region=excluded.region, archetype=excluded.archetype, danger=excluded.danger,
      radiation=excluded.radiation, storm_factor=excluded.storm_factor, bandit_chance=excluded.bandit_chance,
      monster_rate=excluded.monster_rate, merchant_chance=excluded.merchant_chance`);
  db.transaction(() => CITIES.forEach((c) => up.run(c)))();
}

/** Run `fn` in a write transaction (BEGIN IMMEDIATE => no lost updates across processes). Nests as a savepoint. */
export function tx<T>(db: DB, fn: () => T): T {
  return db.transaction(fn).immediate();
}
