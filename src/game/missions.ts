import { type Ctx, fail, result, type Result } from './ctx.js';
import {
  inOpenCrewRaid, loadPlayer, shelterOf, economy, takeItem, addItem, inventory, ratchetOf, wear, vcApply, notify, addTo, lootText, type PlayerRow,
} from './store.js';
import { crewBonus, areCrewmates } from './crews.js';
import { duel, npcStriker, playerStriker } from './combat.js';
import { createMissionVisit } from './merchant.js';
import { addXp } from './players.js';
import { Rng, freshSeed } from './rng.js';
import { CITY_BY_ID, ARCHETYPES, MONSTERS, banditFor, lootTable } from '../data/world.js';
import { ITEMS, label } from '../data/items.js';
import { MISSION_LENGTHS, MIN, bagCapacity, robotBag } from '../data/progression.js';
import { tx } from '../db/index.js';
import { log } from '../logger.js';

// ------------------------------------------------------------------ start
/** Auto-eat/drink the cheapest safe items from the bag to cover a shortfall ("bring food & water with you"). */
export function provision(ctx: Ctx, p: PlayerRow, need: { food: number; water: number }): { food: number; water: number; used: string[] } {
  const { db } = ctx;
  let { food, water } = p;
  const used: string[] = [];
  const inv = inventory(db, p.id);
  const pick = (stat: 'food' | 'water') => Object.keys(inv)
    .filter((id) => (ITEMS[id][stat] ?? 0) > 0 && !ITEMS[id].sickChance && ITEMS[id].kind !== 'seed')
    .sort((a, b) => (ITEMS[a][stat]! - ITEMS[b][stat]!));
  for (const stat of ['food', 'water'] as const) {
    let cur = stat === 'food' ? food : water;
    for (const id of pick(stat)) {
      while (cur < need[stat] && inv[id] > 0) { takeItem(db, p.id, id, 1); inv[id]--; cur += ITEMS[id][stat]!; used.push(label(id, 1)); }
      if (cur >= need[stat]) break;
    }
    if (stat === 'food') food = cur; else water = cur;
  }
  return { food, water, used };
}

export function start(ctx: Ctx, pid: number, lengthId = 'standard'): Result {
  const L = MISSION_LENGTHS[lengthId];
  if (!L) return fail('Length must be quick, standard or deep.');
  return tx(ctx.db, () => {
    const { db } = ctx;
    const p = loadPlayer(ctx, pid);
    const now = ctx.now();
    if (db.prepare("SELECT 1 FROM missions WHERE player_id = ? AND status = 'active'").get(pid)) return fail('You are already on a mission. `/mission report`');
    if (inOpenCrewRaid(db, pid)) return fail('You are signed up for a crew raid. Launch or `/crewraid leave` first.');
    if (p.hp < 20) return fail('You are too wounded (HP < 20). Use a bandage or medkit.');
    const crew = crewBonus(db, pid);
    const energy = Math.max(1, Math.ceil(L.energy * (1 - crew.energyDiscount)));
    if (p.energy < energy) return fail(`This mission needs ${energy}⚡ energy (you have ${p.energy}). Rest, drink coffee or discharge your power bank.`);
    const prov = provision(ctx, p, { food: L.food, water: L.water });
    const shortF = Math.max(0, L.food - prov.food), shortW = Math.max(0, L.water - prov.water);
    const penF = +(shortF / L.food).toFixed(3), penW = +(shortW / L.water).toFixed(3);
    db.prepare('UPDATE players SET energy = energy - ?, food = ?, water = ? WHERE id = ?').run(energy, Math.max(0, prov.food - L.food), Math.max(0, prov.water - L.water), pid);
    const mid = Number(db.prepare('INSERT INTO missions (player_id,city_id,length,started_at,ends_at,energy_cost,pen_food,pen_water,crew_size,seed) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(pid, p.city_id, L.id, now, now + L.minutes * MIN, energy, penF, penW, crew.size, freshSeed()).lastInsertRowid);
    const city = CITY_BY_ID[p.city_id];
    const lines = [
      `🧭 You head into **${city.name}** for a **${L.id}** scavenge (${L.minutes} min). -${energy}⚡ -${L.food}🍖 -${L.water}💧`,
      ...(prov.used.length ? [`🎒 You ate/drank from your pack to prepare: ${prov.used.join(', ')}.`] : []),
      ...(penF || penW ? [`⚠️ Supplies short (${Math.round(penF * 100)}% food, ${Math.round(penW * 100)}% water): expect less loot and more injuries!`] : []),
      ...(crew.energyDiscount ? [`👥 Crew discount applied (-${Math.round(crew.energyDiscount * 100)}% energy).`] : []),
      `Back at <t:${Math.floor((now + L.minutes * MIN) / 1000)}:t> — check \`/mission report\`.`,
    ];
    return result('Mission started', lines, { missionId: mid, endsAt: now + L.minutes * MIN });
  });
}

// ----------------------------------------------------------------- resolve
interface MissionRow { id: number; player_id: number; city_id: string; length: string; status: string; started_at: number; ends_at: number; pen_food: number; pen_water: number; crew_size: number; seed: number }

/** Finish a mission exactly once (status flip + UNIQUE mission_log). Returns the log row. */
export function resolve(ctx: Ctx, missionId: number, opts: { notifyPlayer?: boolean } = {}): any {
  return tx(ctx.db, () => {
    const { db } = ctx;
    const now = ctx.now();
    const flip = db.prepare("UPDATE missions SET status = 'completed', resolved_at = ? WHERE id = ? AND status = 'active' AND ends_at <= ?").run(now, missionId, now);
    if (flip.changes === 0) return db.prepare('SELECT * FROM mission_log WHERE mission_id = ?').get(missionId);
    const m = db.prepare('SELECT * FROM missions WHERE id = ?').get(missionId) as MissionRow;
    const rng = new Rng(m.seed);
    const p = loadPlayer(ctx, m.player_id);
    const city = CITY_BY_ID[m.city_id];
    const L = MISSION_LENGTHS[m.length];
    const e = economy(db);
    const sh = shelterOf(db, p.id);
    const robot = db.prepare("SELECT * FROM robots WHERE player_id = ? AND mode = 'mission' AND durability > 0").get(p.id) as any;
    const ratchet = ratchetOf(db, p.id);
    const ev: string[] = [];
    const loot: Record<string, number> = {};
    let hp = p.hp, kills = 0, down = false;
    const collapse = m.pen_food + m.pen_water >= 1.2;
    const injury = 1 + m.pen_food + m.pen_water;

    let mult = Math.max(0.2, 1 - 0.4 * m.pen_food - 0.4 * m.pen_water) * e.loot_multiplier * (1 + 0.02 * (m.crew_size - 1)) * (robot ? 1 + 0.05 * robot.level : 1);
    if (collapse) { mult *= 0.25; hp -= 15; ev.push('🥵 You collapsed from hunger and thirst and had to turn back with scraps (-15 HP).'); }
    else if (m.pen_food || m.pen_water) ev.push('🥴 Weak from lack of supplies, you missed a lot of loot.');
    if (robot) ev.push(`🤖 Your Scav-Bot (L${robot.level}) hauls extra gear and spots hidden stashes.`);

    // ---- scavenging rolls
    const table = lootTable(city.archetype);
    const rolls = L.rolls + Math.floor(p.level / 10);
    for (let i = 0; i < rolls; i++) {
      const entry = rng.weighted(table, (t) => t.w);
      let n = rng.int(entry.min, entry.max);
      if (entry.salvage && ratchet) n = Math.ceil(n * 1.4);
      addTo(loot, entry.item, Math.floor(n * mult + rng.next()));
    }
    if (ratchet) {
      wear(db, ratchet.id, 3);
      if (rng.chance(0.4)) { const b = rng.pick(['battery', 'circuit', 'wire']); const n = b === 'wire' ? rng.int(1, 3) : 1; addTo(loot, b, n); ev.push(`🔧 Your ratchet strips a wreck: +${label(b, n)}.`); }
    }
    if (city.radiation > 0) {
      const dmg = Math.round(city.radiation * rolls * 1.5);
      if (dmg > 0) { hp -= dmg; ev.push(`☢️ Radiation seeps through your gear (-${dmg} HP).`); }
    }

    // ---- encounters
    if (!collapse) {
      const ambusher = (db.prepare(`SELECT id FROM players WHERE city_id = ? AND id <> ? AND karma <= -3 AND hp >= 30 AND protected_until <= ?
        AND NOT EXISTS (SELECT 1 FROM missions x WHERE x.player_id = players.id AND x.status = 'active') ORDER BY id`).all(city.id, p.id, now) as any[])
        .map((r) => r.id as number).filter((id) => !areCrewmates(db, id, p.id));
      for (let j = 0; j < L.encounters && !down; j++) {
        const kind = rng.weighted(['none', 'monster', 'bandit', 'ambush', 'merchant'] as const, (k) =>
          k === 'none' ? 0.3 : k === 'monster' ? city.monsterRate : k === 'bandit' ? city.banditChance : k === 'ambush' ? (ambusher.length ? 0.12 : 0) : city.merchantChance * 0.8);
        if (kind === 'none') continue;
        if (kind === 'merchant') { createMissionVisit(ctx, p.id, m.id, city.id); ev.push('🧳 You spot the Wandering Merchant! Check `/merchant` within 30 minutes.'); continue; }
        if (kind === 'monster') {
          const pool = ARCHETYPES[city.archetype].monsters.map((id) => MONSTERS[id]).filter((mo) => mo.minDanger <= city.danger && mo.maxDanger >= city.danger);
          const mo = rng.pick(pool.length ? pool : Object.values(MONSTERS).filter((x) => x.minDanger <= city.danger));
          const r = duel(rng, { name: 'you', hp, strike: playerStriker(ctx, p) }, { name: mo.name, hp: mo.hp, strike: (g) => Math.round(npcStriker(mo.dmg)(g) * injury) });
          const lost = hp - r.aHp; hp = r.aHp;
          if (r.winner === 'a') {
            kills++;
            const drops: Record<string, number> = {};
            for (const d of mo.loot) if (rng.chance(d.chance)) addTo(drops, d.item, rng.int(d.min, d.max));
            for (const [k, v] of Object.entries(drops)) addTo(loot, k, v);
            ev.push(`${mo.emoji} A **${mo.name}** leapt from the shadows! You killed it (-${lost} HP) and skinned it: ${lootText(drops)}.`);
            db.prepare("INSERT INTO monster_attack_log (event_key,player_id,context,city_id,monster_id,outcome,loot_json,created_at) VALUES (?,?,'mission',?,?,'killed_by_player',?,?)").run(`mission:${m.id}:${j}`, p.id, city.id, mo.id, JSON.stringify(drops), now);
          } else if (r.winner === 'none') {
            ev.push(`${mo.emoji} A **${mo.name}** mauled you (-${lost} HP) before you broke away.`);
            db.prepare("INSERT INTO monster_attack_log (event_key,player_id,context,city_id,monster_id,outcome,created_at) VALUES (?,?,'mission',?,?,'fled',?)").run(`mission:${m.id}:${j}`, p.id, city.id, mo.id, now);
          } else {
            down = true;
            ev.push(`${mo.emoji} A **${mo.name}** overpowered you! You black out and wake with half your loot gone.`);
            db.prepare("INSERT INTO monster_attack_log (event_key,player_id,context,city_id,monster_id,outcome,created_at) VALUES (?,?,'mission',?,?,'player_down',?)").run(`mission:${m.id}:${j}`, p.id, city.id, mo.id, now);
          }
        } else if (kind === 'bandit') {
          const b = banditFor(city.danger);
          const r = duel(rng, { name: 'you', hp, strike: playerStriker(ctx, p) }, { name: b.name, hp: b.hp, strike: (g) => Math.round(npcStriker(b.dmg)(g) * injury) });
          const lost = hp - r.aHp; hp = r.aHp;
          if (r.winner === 'a') {
            const drops: Record<string, number> = { scrap: rng.int(2, 6) };
            if (rng.chance(0.4)) drops.cloth = rng.int(1, 3);
            if (rng.chance(0.25)) drops[rng.pick(['pebbles', 'arrows', 'bullets'])] = rng.int(3, 6);
            for (const [k, v] of Object.entries(drops)) addTo(loot, k, v);
            ev.push(`🗡️ A **${b.name}** tried to rob you. You beat them (-${lost} HP) and took ${lootText(drops)}.`);
          } else {
            const frac = r.winner === 'b' ? 0.4 : 0.2;
            const stolen = takeFraction(loot, frac);
            if (r.winner === 'b') down = true;
            ev.push(`🗡️ A **${b.name}** robbed you of ${lootText(stolen)}${lost ? ` (-${lost} HP)` : ''}.`);
          }
        } else if (kind === 'ambush') {
          const aid = rng.pick(ambusher);
          const att = loadPlayer(ctx, aid);
          const r = duel(rng, { name: att.name, hp: att.hp, strike: playerStriker(ctx, att) }, { name: p.name, hp, strike: playerStriker(ctx, p) });
          const myLost = hp - r.bHp; hp = r.bHp;
          db.prepare('UPDATE players SET hp = MAX(1, ?) WHERE id = ?').run(r.aHp, aid);
          if (r.winner === 'a') {
            const stolen = takeFraction(loot, 0.35);
            for (const [k, v] of Object.entries(stolen)) addItem(db, aid, k, v);
            db.prepare('UPDATE players SET karma = karma - 1 WHERE id = ?').run(aid);
            down = hp <= 0;
            ev.push(`🏴 **${att.name}**, a known criminal, ambushed you and stole ${lootText(stolen)} (-${myLost} HP)!`);
            db.prepare("INSERT INTO attack_log (kind,attacker_id,defender_id,city_id,outcome,loot_json,attacker_hp_lost,created_at) VALUES ('ambush',?,?,?,'success',?,?,?)").run(aid, p.id, city.id, JSON.stringify(stolen), att.hp - r.aHp, now);
            log.info(`🏴 [pvp] ${att.name} AMBUSHED ${p.name} in ${city.name}, stole ${lootText(stolen)}`);
            notify(ctx, aid, 'ambush', `🏴 You ambushed **${p.name}** in ${city.name} and stole ${lootText(stolen)}.`);
          } else {
            ev.push(r.winner === 'b' ? `🏴 Criminal **${att.name}** jumped you — but you fought them off (-${myLost} HP)!` : `🏴 **${att.name}** ambushed you; the scuffle ended in a stalemate (-${myLost} HP).`);
            if (r.winner === 'b') db.prepare('UPDATE players SET karma = karma + 1 WHERE id = ?').run(p.id);
            db.prepare("INSERT INTO attack_log (kind,attacker_id,defender_id,city_id,outcome,attacker_hp_lost,created_at) VALUES ('ambush',?,?,?,?,?,?)").run(aid, p.id, city.id, r.winner === 'b' ? 'defeated' : 'failed', att.hp - r.aHp, now);
            notify(ctx, aid, 'ambush', `🏴 Your ambush on **${p.name}** failed.`);
          }
        }
      }
    }

    if (down) { hp = 1; for (const k of Object.keys(loot)) loot[k] = Math.floor(loot[k] / 2); }
    hp = Math.max(1, hp);

    // ---- bag capacity (robot adds space). Overflow drops the cheapest items.
    const cap = bagCapacity(p.level, sh.level) + (robot ? robotBag(robot.level) : 0);
    const dropped = fitToBag(loot, cap);
    if (Object.keys(dropped).length) ev.push(`🎒 Your bag was full — you had to leave behind ${lootText(dropped)}.`);
    for (const [k, v] of Object.entries(loot)) if (v > 0) addItem(db, p.id, k, v); else delete loot[k];

    // ---- Void Coin drop (rare, capped per day => no farming exploit)
    let vc = 0;
    if (!collapse && rng.chance(Math.min(0.5, e.vc_drop_rate * city.danger))) {
      vc = rng.int(1, 1 + city.danger);
      const minted = (db.prepare("SELECT COALESCE(SUM(delta),0) s FROM void_coin_transactions WHERE player_id = ? AND reason = 'mission_drop' AND created_at > ?").get(p.id, now - 24 * 60 * MIN) as any).s;
      vc = Math.min(vc, Math.max(0, e.vc_daily_mission_cap - minted));
      if (vc > 0 && vcApply(ctx, p.id, vc, 'mission_drop', `mission:${m.id}:drop`, `mission ${m.id}`)) ev.push(`🪙 You found **${vc} Void Coin${vc > 1 ? 's' : ''}** hidden in a collapsed vault!`);
      else vc = 0;
    }

    if (robot) db.prepare('UPDATE robots SET durability = MAX(0, durability - 3) WHERE player_id = ?').run(p.id);
    const xp = L.xp + city.danger * 5 + kills * 10;
    db.prepare('UPDATE players SET hp = ? WHERE id = ?').run(hp, p.id);
    const lvl = addXp(ctx, p.id, xp);
    const outcome = down ? 'failed' : collapse ? 'failed' : 'completed';
    if (outcome === 'failed') db.prepare("UPDATE missions SET status = 'failed' WHERE id = ?").run(m.id);
    const hpLost = p.hp - hp;
    const lootClean = Object.fromEntries(Object.entries(loot).filter(([, v]) => v > 0));
    db.prepare('INSERT INTO mission_log (mission_id,player_id,city_id,outcome,loot_json,events_json,hp_lost,vc_found,xp_gained,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(m.id, p.id, city.id, outcome, JSON.stringify(lootClean), JSON.stringify([...ev, ...lvl]), Math.max(0, hpLost), vc, xp, now);
    log.info(`🧭 [mission] ${p.name} finished in ${city.name}: ${outcome}, loot ${lootText(lootClean)}${vc ? `, +${vc} VC` : ''}${hpLost > 0 ? `, -${hpLost} HP` : ''}`);
    if (opts.notifyPlayer) notify(ctx, p.id, 'mission', `🧭 Your ${m.length} mission in **${city.name}** is complete (${outcome}). Use \`/mission report\`.`);
    return db.prepare('SELECT * FROM mission_log WHERE mission_id = ?').get(m.id);
  });
}

/** Remove `frac` of each stack from `loot` (in place) and return what was removed. */
function takeFraction(loot: Record<string, number>, frac: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(loot)) { const t = Math.floor(loot[k] * frac); if (t > 0) { loot[k] -= t; out[k] = t; } }
  return out;
}
/** Trim `loot` to `cap` units, dropping the lowest-value items first. Returns dropped items. */
function fitToBag(loot: Record<string, number>, cap: number): Record<string, number> {
  const dropped: Record<string, number> = {};
  let total = Object.values(loot).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(loot).sort((a, b) => ITEMS[a].value - ITEMS[b].value)) {
    while (total > cap && loot[k] > 0) { loot[k]--; total--; dropped[k] = (dropped[k] ?? 0) + 1; }
  }
  return dropped;
}

// ------------------------------------------------------------------ report
const fmtLog = (log: any): Result => {
  const loot = JSON.parse(log.loot_json), events = JSON.parse(log.events_json) as string[];
  return result(`Mission report — ${CITY_BY_ID[log.city_id]?.name} (${log.outcome})`, [
    ...events, '', `📦 Loot: ${lootText(loot)}`, `⭐ +${log.xp_gained} xp${log.hp_lost ? ` · ❤️ -${log.hp_lost} HP` : ''}${log.vc_found ? ` · 🪙 +${log.vc_found}` : ''}`,
  ], { log: { ...log, loot, events } });
};

export function report(ctx: Ctx, pid: number): Result {
  const { db } = ctx;
  const active = db.prepare("SELECT * FROM missions WHERE player_id = ? AND status = 'active'").get(pid) as MissionRow | undefined;
  if (active) {
    if (active.ends_at > ctx.now()) {
      const left = Math.ceil((active.ends_at - ctx.now()) / MIN);
      return result('Mission in progress', [`🧭 Scavenging in **${CITY_BY_ID[active.city_id].name}** — ${left} min left (back at <t:${Math.floor(active.ends_at / 1000)}:t>).`], { active });
    }
    return fmtLog(resolve(ctx, active.id));
  }
  const last = db.prepare('SELECT * FROM mission_log WHERE player_id = ? ORDER BY id DESC LIMIT 1').get(pid);
  if (!last) return fail('You have not been on a mission yet. `/mission start`.');
  return fmtLog(last);
}
