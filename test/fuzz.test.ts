import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from '../src/db/index.js';
import type { Ctx } from '../src/game/ctx.js';
import { run } from '../src/game/actions.js';
import { resolve } from '../src/game/missions.js';
import { MIN } from '../src/data/progression.js';
import { CITIES } from '../src/data/world.js';

test('every city/length resolves without errors and keeps invariants', () => {
  const db = openDb(':memory:'); migrate(db);
  let t = Date.UTC(2999, 5, 1);
  const ctx: Ctx = { db, now: () => t };
  const pid = (run(ctx, 'player/register', null, { name: 'Fuzzer' }).data as any).playerId;
  const crook = (run(ctx, 'player/register', null, { name: 'Crook' }).data as any).playerId;
  db.prepare('UPDATE players SET karma = -5, protected_until = 0 WHERE id = ?').run(crook);
  let missions = 0;
  for (const c of CITIES) for (const len of ['quick', 'standard', 'deep']) {
    db.prepare('UPDATE players SET city_id = ?, hp = max_hp, energy = 100, food = 100, water = 100 WHERE id IN (?, ?)').run(c.id, pid, crook);
    run(ctx, 'mission/start', pid, { length: len });
    t += 31 * MIN;
    const id = (db.prepare("SELECT id FROM missions WHERE player_id = ? AND status = 'active'").get(pid) as any).id;
    resolve(ctx, id);
    missions++;
  }
  assert.equal((db.prepare('SELECT COUNT(*) n FROM mission_log').get() as any).n, missions);
  const p = db.prepare('SELECT * FROM players WHERE id = ?').get(pid) as any;
  assert.ok(p.hp >= 1 && p.food >= 0 && p.water >= 0 && p.energy >= 0);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM player_inventory WHERE quantity < 0').get() as any).n, 0);
  const minted = (db.prepare('SELECT COALESCE(SUM(delta),0) s FROM void_coin_transactions').get() as any).s;
  assert.equal(minted, p.void_coins + (db.prepare('SELECT void_coins v FROM players WHERE id = ?').get(crook) as any).v); // ledger == balances
  console.log(`  ${missions} missions OK, level ${p.level}, VC minted ${minted}`);
});
