/**
 * Periodic world simulation: storms, monster attacks on shelters, merchant cleanup, mission resolution.
 *
 * Idempotency strategy (safe to run from the bot AND the web process, or after downtime):
 *  - time is divided into integer SLOTS (floor(now / interval)); each slot has a deterministic event_key
 *  - `watcher_cursors` records the last slot fully processed; at most `max_catchup_slots` old slots are replayed
 *  - world_events.event_key / shelter_event_log(player_id,event_key) / monster_attack_log.event_key are UNIQUE,
 *    so even if two processes race, an event is applied at most once per target.
 */
import { type Ctx } from './ctx.js';
import { worldState, notify, addItem, addTo, lootText, structureLevel, inventory, type ShelterRow } from './store.js';
import { expireMerchants } from './merchant.js';
import { resolve } from './missions.js';
import { expireLobbies } from './crewraids.js';
import { Rng, hashSeed } from './rng.js';
import { CITY_BY_ID, ARCHETYPES, MONSTERS } from '../data/world.js';
import { MIN, turretDamage } from '../data/progression.js';
import { ITEMS } from '../data/items.js';
import { tx } from '../db/index.js';
import { log } from '../logger.js';

function cursor(ctx: Ctx, name: string, initial: number): number {
  ctx.db.prepare('INSERT OR IGNORE INTO watcher_cursors (name,cursor,updated_at) VALUES (?,?,?)').run(name, initial, ctx.now());
  return (ctx.db.prepare('SELECT cursor FROM watcher_cursors WHERE name = ?').get(name) as any).cursor;
}
const advance = (ctx: Ctx, name: string, slot: number) =>
  ctx.db.prepare('UPDATE watcher_cursors SET cursor = MAX(cursor, ?), updated_at = ? WHERE name = ?').run(slot, ctx.now(), name);

// ------------------------------------------------------------------ storms
export const stormSeverity = (slot: number): 1 | 2 | 3 => {
  const r = new Rng(hashSeed(`storm:${slot}`)).next();
  return r < 0.5 ? 1 : r < 0.85 ? 2 : 3;
};

function applyStorm(ctx: Ctx, slot: number, slotStart: number): number {
  const { db } = ctx;
  const sev = stormSeverity(slot);
  db.prepare("INSERT OR IGNORE INTO world_events (event_key,kind,slot,payload,created_at) VALUES (?,'storm',?,?,?)").run(`storm:${slot}`, slot, JSON.stringify({ severity: sev }), ctx.now());
  const shelters = db.prepare('SELECT s.*, p.created_at AS pc FROM shelters s JOIN players p ON p.id = s.player_id WHERE s.built = 1 AND p.created_at <= ?').all(slotStart) as (ShelterRow & { pc: number })[];
  let hit = 0;
  for (const s of shelters) {
    const factor = CITY_BY_ID[s.city_id].stormFactor;
    const dmg = Math.max(1, Math.round(sev * 8 * factor * (1 - 0.08 * (s.level - 1))));
    const doorDmg = Math.round(dmg / 2);
    // UNIQUE(player_id,event_key): only the process that inserts the row applies the damage.
    const ins = db.prepare("INSERT OR IGNORE INTO shelter_event_log (player_id,kind,delta_hp,event_key,details,created_at) VALUES (?,'storm',?,?,?,?)")
      .run(s.player_id, -dmg, `storm:${slot}`, JSON.stringify({ severity: sev, doorDmg }), ctx.now());
    if (ins.changes === 0) continue;
    db.prepare('UPDATE shelters SET hp = MAX(0, hp - ?), door_hp = MAX(0, door_hp - ?) WHERE player_id = ?').run(dmg, doorDmg, s.player_id);
    hit++;
    if (s.hp - dmg < s.max_hp * 0.5) notify(ctx, s.player_id, 'storm', `🌪️ A **${['', 'mild', 'strong', 'violent'][sev]} storm** battered your shelter (-${dmg} HP). It's at ${Math.max(0, s.hp - dmg)}/${s.max_hp} — repair with \`/shelter repair\` using scrap.`);
  }
  log.info(`🌪️ [world] storm (${['', 'mild', 'strong', 'violent'][sev]}) hit ${hit} shelter(s)`);
  return hit;
}

// -------------------------------------------------------- monster attacks
function monsterAttack(ctx: Ctx, slot: number, p: { id: number; city_id: string }): void {
  const { db } = ctx;
  const key = `monster:${slot}:${p.id}`;
  const city = CITY_BY_ID[p.city_id];
  const w = worldState(db);
  const rng = new Rng(hashSeed(key));
  if (!rng.chance(Math.min(0.6, city.monsterRate * 0.5 * w.monster_attack_rate))) return;
  if (db.prepare('SELECT 1 FROM monster_attack_log WHERE event_key = ?').get(key)) return;
  const sh = db.prepare('SELECT * FROM shelters WHERE player_id = ?').get(p.id) as ShelterRow;
  if (!sh.built) return; // no shelter, nothing for monsters to attack
  const pool = ARCHETYPES[city.archetype].monsters.map((id) => MONSTERS[id]).filter((m) => m.minDanger <= city.danger && m.maxDanger >= city.danger);
  const mo = rng.pick(pool.length ? pool : Object.values(MONSTERS).filter((m) => m.minDanger <= city.danger));
  let mhp = mo.hp, power = sh.power_charge;
  const tl = structureLevel(db, p.id, 'turret');
  const traps = structureLevel(db, p.id, 'trap')?.quantity ?? 0;
  const robot = db.prepare("SELECT * FROM robots WHERE player_id = ? AND mode = 'home' AND durability > 0").get(p.id) as any;
  const notes: string[] = [];
  if (traps && rng.chance(0.6)) { mhp -= 15; db.prepare("UPDATE shelter_structures SET quantity = quantity - 1 WHERE player_id = ? AND structure = 'trap'").run(p.id); notes.push('a trap sprang'); }
  for (let r = 0; r < 3 && mhp > 0; r++) {
    if (tl) for (let i = 0; i < tl.quantity && power > 0 && mhp > 0; i++) { power--; if (rng.chance(0.75)) mhp -= turretDamage(tl.level); }
    if (robot && rng.chance(0.8)) mhp -= 6 + 4 * robot.level;
  }
  if (tl) db.prepare('UPDATE shelters SET power_charge = ? WHERE player_id = ?').run(power, p.id);
  if (robot) db.prepare('UPDATE robots SET durability = MAX(0, durability - 2) WHERE player_id = ?').run(p.id);

  let outcome: string, dmg = 0, loot: Record<string, number> = {}, msg: string;
  if (mhp <= 0) {
    outcome = 'killed_by_turret';
    for (const d of mo.loot) if (rng.chance(d.chance)) addTo(loot, d.item, rng.int(d.min, d.max) * (robot ? 2 : 1));
    for (const [k, v] of Object.entries(loot)) addItem(db, p.id, k, v);
    msg = `${mo.emoji} A **${mo.name}** attacked your shelter and was gunned down by your defenses${robot ? ' (your Scav-Bot hauled in double loot)' : ''}! Loot collected: ${lootText(loot)}.`;
  } else {
    const hit = rng.int(mo.dmg[0], mo.dmg[1]);
    const doorHp = sh.door_hp;
    if (doorHp > Math.round(hit * 1.5)) {
      outcome = 'repelled'; dmg = Math.round(hit / 3);
      db.prepare('UPDATE shelters SET door_hp = door_hp - ?, hp = MAX(0, hp - ?) WHERE player_id = ?').run(Math.round(hit * 1.5), dmg, p.id);
      msg = `${mo.emoji} A **${mo.name}** clawed at your door and gave up. Door -${Math.round(hit * 1.5)} HP, shelter -${dmg} HP.${!tl ? ' (Turrets would have killed it for loot!)' : power < 1 ? ' ⚠️ Your turrets had no power!' : ''}`;
    } else {
      outcome = 'breached'; dmg = Math.round(hit * 1.5);
      db.prepare('UPDATE shelters SET door_hp = 0, hp = MAX(0, hp - ?) WHERE player_id = ?').run(dmg, p.id);
      const food: Record<string, number> = {};
      for (const [k, n] of Object.entries(inventory(db, p.id))) if (ITEMS[k].food && !ITEMS[k].sickChance) { const t = Math.ceil(n * 0.2); db.prepare('UPDATE player_inventory SET quantity = quantity - ? WHERE player_id = ? AND item_id = ?').run(t, p.id, k); food[k] = t; }
      db.prepare('DELETE FROM player_inventory WHERE player_id = ? AND quantity = 0').run(p.id);
      loot = {};
      msg = `${mo.emoji} A **${mo.name}** BROKE IN! Shelter -${dmg} HP, door destroyed, it ate ${lootText(food)}. Repair your door before raiders notice! (Vault items were safe.)`;
    }
  }
  db.prepare('INSERT INTO monster_attack_log (event_key,player_id,context,city_id,monster_id,outcome,shelter_damage,loot_json,created_at) VALUES (?,?,\'shelter\',?,?,?,?,?,?)')
    .run(key, p.id, city.id, mo.id, outcome, dmg, JSON.stringify(loot), ctx.now());
  db.prepare("INSERT OR IGNORE INTO shelter_event_log (player_id,kind,delta_hp,event_key,details,created_at) VALUES (?,'monster',?,?,?,?)").run(p.id, -dmg, key, JSON.stringify({ monster: mo.id, outcome, notes }), ctx.now());
  notify(ctx, p.id, 'monster', msg);
  log.info(`🐾 [world] ${mo.name} attacked ${(db.prepare('SELECT name FROM players WHERE id = ?').get(p.id) as any).name}'s shelter → ${outcome}`);
}

// -------------------------------------------------------------------- tick
/** Process everything that is due. `force` bypasses the 5 s throttle (used by the interval timer and tests). */
export function tick(ctx: Ctx, force = false): void {
  const { db } = ctx;
  const now = ctx.now();
  const w = worldState(db);
  if (!force && now - w.last_tick_at < 5000) return;
  tx(db, () => {
    db.prepare('UPDATE world_state SET last_tick_at = ? WHERE id = 1').run(now);
    // storms
    const sMs = w.storm_interval_minutes * MIN, curStorm = Math.floor(now / sMs);
    const sCur = cursor(ctx, 'storm', curStorm - 1);
    for (let s = Math.max(sCur + 1, curStorm - w.max_catchup_slots + 1); s <= curStorm; s++) applyStorm(ctx, s, s * sMs);
    advance(ctx, 'storm', curStorm);
    // monsters at shelters
    const mMs = w.monster_tick_minutes * MIN, curM = Math.floor(now / mMs);
    const mCur = cursor(ctx, 'monster', curM - 1);
    for (let s = Math.max(mCur + 1, curM - w.max_catchup_slots + 1); s <= curM; s++) {
      const players = db.prepare('SELECT id, city_id FROM players WHERE created_at <= ? AND last_seen_at > ?').all(s * mMs, now - 7 * 24 * 60 * MIN) as any[];
      for (const p of players) monsterAttack(ctx, s, p);
    }
    advance(ctx, 'monster', curM);
    expireMerchants(db, now);
    db.prepare('DELETE FROM web_sessions WHERE expires_at < ?').run(now);
    db.prepare('DELETE FROM web_link_codes WHERE expires_at < ?').run(now - 60 * MIN);
    db.prepare('DELETE FROM crew_invites WHERE expires_at < ?').run(now);
  });
  try { expireLobbies(ctx); } catch (err) { log.error(`crew raid lobby cleanup failed: ${(err as Error).stack ?? err}`); }
  // missions are resolved one-by-one (each in its own tx) so one bad row can't block the rest
  const due = db.prepare("SELECT id FROM missions WHERE status = 'active' AND ends_at <= ?").all(now) as { id: number }[];
  for (const m of due) { try { resolve(ctx, m.id, { notifyPlayer: true }); } catch (err) { log.error(`mission ${m.id} resolve failed: ${(err as Error).stack ?? err}`); } }
}

export function worldStatus(ctx: Ctx): { nextStormAt: number; stormSeverity: number; interval: number } {
  const w = worldState(ctx.db);
  const ms = w.storm_interval_minutes * MIN;
  const next = (Math.floor(ctx.now() / ms) + 1) * ms;
  return { nextStormAt: next, stormSeverity: stormSeverity(Math.floor(next / ms)), interval: w.storm_interval_minutes };
}
