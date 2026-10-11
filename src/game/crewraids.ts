/**
 * Crew raids. Flow: a leader/permitted member OPENS a lobby (pays their share), crew members in the same city JOIN
 * (each pays energy + food + water), then it is LAUNCHED once. Targets:
 *   monster  – hunt a monster nest (boss-sized monster, rich drops)
 *   building – clear an abandoned bigger building in waves for far better loot than solo missions
 *   crew     – raid a rival crew's hideout and steal from THEIR crew vault
 * Loot goes to the crew vault (leader decides who gets what). Resolution is exactly-once (status flip + UNIQUE log row).
 */
import { type Ctx, fail, result, type Result } from './ctx.js';
import { loadPlayer, economy, notify, addItem, addTo, lootText, structureLevel, type PlayerRow } from './store.js';
import { accessOf, vaultAdd } from './crewvault.js';
import { playerStriker, npcStriker } from './combat.js';
import { provision } from './missions.js';
import { addXp } from './players.js';
import { Rng, freshSeed } from './rng.js';
import { ARCHETYPES, CITY_BY_ID, MONSTERS, banditFor, lootTable, type CityDef, type MonsterDef } from '../data/world.js';
import { BUILDINGS } from '../data/buildings.js';
import { MIN, turretDamage } from '../data/progression.js';
import { tx, type DB } from '../db/index.js';
import { log } from '../logger.js';

type Kind = 'monster' | 'building' | 'crew';
/** Per-member cost. Heavier than a deep solo mission: crews should plan food, water and rest. */
function costOf(kind: Kind, city: CityDef) {
  return kind === 'building' ? { energy: 30 + city.danger * 2, food: 20, water: 25 } : { energy: 25, food: 15, water: 18 };
}
const eligibleMonsters = (city: CityDef): MonsterDef[] => {
  const pool = ARCHETYPES[city.archetype].monsters.map((id) => MONSTERS[id]).filter((m) => m.minDanger <= city.danger && m.maxDanger >= city.danger);
  return pool.length ? pool : Object.values(MONSTERS).filter((m) => m.minDanger <= city.danger).slice(-2);
};

// ---------------------------------------------------------------- targets
export function targets(ctx: Ctx, pid: number): Result {
  const { db } = ctx;
  const me = loadPlayer(ctx, pid);
  const a = accessOf(db, pid);
  const city = CITY_BY_ID[me.city_id];
  const b = BUILDINGS[city.archetype];
  const e = economy(db);
  const now = ctx.now();
  const monsters = eligibleMonsters(city);
  const rivals = (db.prepare(`SELECT c.id, c.name, c.tag, c.created_at, c.raid_shield_until, (SELECT COUNT(*) FROM crew_members x WHERE x.crew_id = c.id) AS members,
      (SELECT COALESCE(SUM(quantity),0) FROM crew_vault v WHERE v.crew_id = c.id) AS vault
    FROM crews c JOIN players o ON o.id = c.owner_id WHERE o.home_city_id = ? AND c.id <> ?`).all(me.city_id, a.crew.id) as any[]).map((c) => ({
    ...c, reason: c.created_at + e.crew_newbie_protect_minutes * MIN > now ? 'new crew protection' : c.raid_shield_until > now ? `shielded ${Math.ceil((c.raid_shield_until - now) / MIN)}m`
      : recentPair(db, a.crew.id, c.id, now, e.crew_raid_cooldown_minutes) ? 'cooldown' : null,
  }));
  const k = (x: Kind) => costOf(x, city);
  const lines = [
    `📍 **${city.name}** — crew raids need at least ${e.crew_raid_min_members} of you here. Cost per member: monster/crew ${k('monster').energy}⚡ ${k('monster').food}🍖 ${k('monster').water}💧 · building ${k('building').energy}⚡ ${k('building').food}🍖 ${k('building').water}💧`,
    '', '**🐾 Monster nests** — `/crewraid start kind:monster target:<id>`',
    ...monsters.map((m) => `• \`${m.id}\` ${m.emoji} ${m.name} nest (boss: ${m.hp * 3} HP)`),
    '', '**🏚️ Abandoned building** — `/crewraid start kind:building`',
    `• ${b.emoji} **${b.name}** — ${city.danger >= 4 ? 3 : 2} guarded waves, guaranteed premium loot`,
    '', `**⚔️ Rival crews with a hideout here** — \`/crewraid start kind:crew target:<crew name>\``,
    ...(rivals.length ? rivals.map((c) => `• [${c.tag}] ${c.name} — ${c.members} members, vault ${c.vault} units${c.reason ? ` · 🛡️ ${c.reason}` : ' · **can be raided**'}`) : ['• none in this city']),
  ];
  return result('Crew raid targets', lines, { monsters, building: { id: b.id, name: b.name }, rivals, costs: { monster: k('monster'), building: k('building'), crew: k('crew' as Kind) } });
}

const recentPair = (db: DB, attackerCrew: number, defenderCrew: number, now: number, cdMin: number) =>
  !!db.prepare("SELECT 1 FROM crew_raid_log WHERE crew_id = ? AND defender_crew_id = ? AND created_at > ?").get(attackerCrew, defenderCrew, now - cdMin * MIN);

// ------------------------------------------------------------------ lobby
function openRaid(db: DB, crewId: number): any {
  return db.prepare("SELECT * FROM crew_raids WHERE crew_id = ? AND status = 'recruiting'").get(crewId);
}

/** Pay a member's cost: bars are spent, short supplies are auto-covered from safe pack items, any shortfall weakens them. */
function payIn(ctx: Ctx, raidId: number, p: PlayerRow, kind: Kind, city: CityDef): void {
  const { db } = ctx;
  const c = costOf(kind, city);
  if (p.hp < 40) fail('You are too wounded to raid (HP < 40).');
  if (p.energy < c.energy) fail(`You need ${c.energy}⚡ energy for this raid (you have ${p.energy}).`);
  const prov = provision(ctx, p, { food: c.food, water: c.water });
  const penF = +(Math.max(0, c.food - prov.food) / c.food).toFixed(3), penW = +(Math.max(0, c.water - prov.water) / c.water).toFixed(3);
  db.prepare('UPDATE players SET energy = energy - ?, food = ?, water = ? WHERE id = ?').run(c.energy, Math.max(0, prov.food - c.food), Math.max(0, prov.water - c.water), p.id);
  db.prepare('INSERT INTO crew_raid_members (raid_id,player_id,energy_paid,food_paid,water_paid,pen_food,pen_water,joined_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(raidId, p.id, c.energy, c.food, c.water, penF, penW, ctx.now());
}

function refund(ctx: Ctx, raidId: number): void {
  const { db } = ctx;
  const rows = db.prepare('SELECT * FROM crew_raid_members WHERE raid_id = ?').all(raidId) as any[];
  for (const m of rows) {
    db.prepare('UPDATE players SET energy = MIN(max_energy, energy + ?), food = MIN(max_food, food + ?), water = MIN(max_water, water + ?) WHERE id = ?').run(m.energy_paid, m.food_paid, m.water_paid, m.player_id);
  }
  db.prepare('DELETE FROM crew_raid_members WHERE raid_id = ?').run(raidId);
}

export function start(ctx: Ctx, pid: number, kind: string, targetQ?: string): Result {
  if (!['monster', 'building', 'crew'].includes(kind)) return fail('Raid kind must be monster, building or crew.');
  return tx(ctx.db, () => {
    const { db } = ctx;
    const a = accessOf(db, pid);
    if (!a.canRaid) fail('Only the crew leader (or members they trust with `can_raid`) can open a crew raid.');
    const me = loadPlayer(ctx, pid);
    const city = CITY_BY_ID[me.city_id];
    const e = economy(db);
    const now = ctx.now();
    if (openRaid(db, a.crew.id)) fail('Your crew already has a raid lobby open. `/crewraid status`');
    if (db.prepare("SELECT 1 FROM missions WHERE player_id = ? AND status = 'active'").get(pid)) fail('Finish your mission first.');
    let target: string, desc: string;
    if (kind === 'monster') {
      const m = eligibleMonsters(city).find((x) => x.id === (targetQ ?? '').toLowerCase().replace(/\s+/g, '_')) ?? eligibleMonsters(city)[eligibleMonsters(city).length - 1];
      target = m.id; desc = `${m.emoji} ${m.name} nest`;
    } else if (kind === 'building') {
      target = BUILDINGS[city.archetype].id; desc = `${BUILDINGS[city.archetype].emoji} ${BUILDINGS[city.archetype].name}`;
    } else {
      const c = db.prepare('SELECT c.*, o.home_city_id FROM crews c JOIN players o ON o.id = c.owner_id WHERE (c.name = ? OR c.tag = ?)').get(targetQ ?? '', targetQ ?? '') as any;
      if (!c) fail('Name a rival crew: `/crewraid start kind:crew target:<crew name>`.');
      if (c.id === a.crew.id) fail('You cannot raid your own crew.');
      if (c.home_city_id !== me.city_id) fail(`[${c.tag}]'s hideout is in ${CITY_BY_ID[c.home_city_id].name}. Travel there first.`);
      if (c.created_at + e.crew_newbie_protect_minutes * MIN > now) fail(`[${c.tag}] is a new crew under protection.`);
      if (c.raid_shield_until > now) fail(`[${c.tag}] was just raided and is shielded for ${Math.ceil((c.raid_shield_until - now) / MIN)} min.`);
      if (recentPair(db, a.crew.id, c.id, now, e.crew_raid_cooldown_minutes)) fail(`You raided [${c.tag}] recently — cooldown.`);
      target = String(c.id); desc = `⚔️ crew [${c.tag}] ${c.name}`;
    }
    const raidId = Number(db.prepare('INSERT INTO crew_raids (crew_id,kind,target,city_id,starter_id,seed,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(a.crew.id, kind, target, me.city_id, pid, freshSeed(), now, now + e.crew_raid_recruit_minutes * MIN).lastInsertRowid);
    payIn(ctx, raidId, me, kind as Kind, city);
    const c = costOf(kind as Kind, city);
    for (const m of db.prepare('SELECT player_id FROM crew_members WHERE crew_id = ? AND player_id <> ?').all(a.crew.id, pid) as any[]) {
      notify(ctx, m.player_id, 'crew', `🚨 **${me.name}** is recruiting for a crew raid on ${desc} in ${city.name}! Be in ${city.name} and use \`/crewraid join\` (costs ${c.energy}⚡ ${c.food}🍖 ${c.water}💧). Open for ${e.crew_raid_recruit_minutes} min.`);
    }
    log.info(`🚨 [crewraid] ${me.name} opened a ${kind} raid on ${desc} in ${city.name} for [${a.crew.tag}]`);
    return result('Crew raid lobby open', [
      `🚨 Raid on **${desc}** in ${city.name}. You paid ${c.energy}⚡ ${c.food}🍖 ${c.water}💧.`,
      `Crewmates in ${city.name} can \`/crewraid join\` for ${e.crew_raid_recruit_minutes} min. Need at least ${e.crew_raid_min_members}. Launch with \`/crewraid launch\`.`,
    ], { raidId });
  });
}

export function join(ctx: Ctx, pid: number): Result {
  return tx(ctx.db, () => {
    const { db } = ctx;
    const a = accessOf(db, pid);
    const raid = openRaid(db, a.crew.id) ?? fail('Your crew has no raid lobby open.');
    if (raid.expires_at <= ctx.now()) fail('That lobby has expired.');
    if (db.prepare('SELECT 1 FROM crew_raid_members WHERE raid_id = ? AND player_id = ?').get(raid.id, pid)) fail('You are already in this raid.');
    const me = loadPlayer(ctx, pid);
    if (me.city_id !== raid.city_id) fail(`You must be in ${CITY_BY_ID[raid.city_id].name} to join.`);
    if (db.prepare("SELECT 1 FROM missions WHERE player_id = ? AND status = 'active'").get(pid)) fail('Finish your mission first.');
    const n = (db.prepare('SELECT COUNT(*) n FROM crew_raid_members WHERE raid_id = ?').get(raid.id) as any).n;
    if (n >= economy(db).crew_raid_max_members) fail('The raid party is full.');
    payIn(ctx, raid.id, me, raid.kind, CITY_BY_ID[raid.city_id]);
    log.info(`🚨 [crewraid] ${me.name} joined the raid (${n + 1} so far)`);
    return result('Joined raid', [`✅ You joined the crew raid (${n + 1} in the party). Wait for the launch.`]);
  });
}

export function leave(ctx: Ctx, pid: number): Result {
  return tx(ctx.db, () => {
    const { db } = ctx;
    const a = accessOf(db, pid);
    const raid = openRaid(db, a.crew.id) ?? fail('Your crew has no raid lobby open.');
    if (raid.starter_id === pid) return cancelRaid(ctx, raid, 'The organiser left, so the raid was cancelled.');
    const m = db.prepare('SELECT * FROM crew_raid_members WHERE raid_id = ? AND player_id = ?').get(raid.id, pid) as any;
    if (!m) fail('You are not in this raid.');
    db.prepare('UPDATE players SET energy = MIN(max_energy, energy + ?), food = MIN(max_food, food + ?), water = MIN(max_water, water + ?) WHERE id = ?').run(m.energy_paid, m.food_paid, m.water_paid, pid);
    db.prepare('DELETE FROM crew_raid_members WHERE raid_id = ? AND player_id = ?').run(raid.id, pid);
    return result('Left raid', ['You left the raid and got your energy/food/water back (items eaten from your pack are not returned).']);
  });
}

export function cancel(ctx: Ctx, pid: number): Result {
  return tx(ctx.db, () => {
    const a = accessOf(ctx.db, pid);
    const raid = openRaid(ctx.db, a.crew.id) ?? fail('Your crew has no raid lobby open.');
    if (raid.starter_id !== pid && !a.owner) fail('Only the organiser or the crew leader can cancel.');
    return cancelRaid(ctx, raid, 'The raid was cancelled.');
  });
}
function cancelRaid(ctx: Ctx, raid: any, why: string): Result {
  const members = ctx.db.prepare('SELECT player_id FROM crew_raid_members WHERE raid_id = ?').all(raid.id) as any[];
  refund(ctx, raid.id);
  ctx.db.prepare("UPDATE crew_raids SET status = 'cancelled', resolved_at = ? WHERE id = ? AND status = 'recruiting'").run(ctx.now(), raid.id);
  for (const m of members) notify(ctx, m.player_id, 'crew', `🚫 ${why} Your energy, food and water were refunded.`);
  log.info(`🚫 [crewraid] raid #${raid.id} cancelled: ${why}`);
  return result('Raid cancelled', [`🚫 ${why} Everyone was refunded.`]);
}

/** Housekeeping from the world ticker: close lobbies nobody launched (refunds everyone). */
export function expireLobbies(ctx: Ctx): void {
  for (const r of ctx.db.prepare("SELECT * FROM crew_raids WHERE status = 'recruiting' AND expires_at <= ?").all(ctx.now()) as any[]) {
    tx(ctx.db, () => cancelRaid(ctx, r, 'The raid lobby timed out.'));
  }
}

export function status(ctx: Ctx, pid: number): Result {
  const { db } = ctx;
  const a = accessOf(db, pid);
  const raid = openRaid(db, a.crew.id);
  const lines: string[] = [];
  let data: any = {};
  if (raid) {
    const mem = db.prepare('SELECT p.name, m.pen_food, m.pen_water FROM crew_raid_members m JOIN players p ON p.id = m.player_id WHERE m.raid_id = ? ORDER BY m.joined_at').all(raid.id) as any[];
    lines.push(`🚨 **Lobby open** — ${raid.kind} raid in ${CITY_BY_ID[raid.city_id].name}, closes in ${Math.max(0, Math.ceil((raid.expires_at - ctx.now()) / MIN))} min`,
      `Party (${mem.length}): ${mem.map((m) => m.name + (m.pen_food || m.pen_water ? ' ⚠️short on supplies' : '')).join(', ')}`);
    data = { raid, members: mem };
  } else lines.push('No raid lobby open.');
  const last = db.prepare('SELECT * FROM crew_raid_log WHERE crew_id = ? ORDER BY id DESC LIMIT 1').get(a.crew.id) as any;
  if (last) lines.push('', `**Last raid** (${last.outcome}): ${lootText(JSON.parse(last.loot_json))} · <t:${Math.floor(last.created_at / 1000)}:R>`);
  return result('Crew raid', lines, { ...data, last });
}

// ------------------------------------------------------------------ combat
interface Fighter { p: PlayerRow; hp: number; strike: (r: Rng) => number; factor: number }
interface Enemy { name: string; hp: number; strikes: ((r: Rng) => number)[] }

/** Whole party swings, then every enemy strike hits a random living member. Up to 10 rounds. */
function groupFight(rng: Rng, party: Fighter[], enemy: Enemy): { won: boolean; enemyHp: number; rounds: number } {
  let hp = enemy.hp, r = 0;
  while (r < 10 && hp > 0 && party.some((m) => m.hp > 0)) {
    r++;
    for (const m of party) if (m.hp > 0) hp -= Math.round(m.strike(rng) * m.factor);
    if (hp <= 0) break;
    for (const s of enemy.strikes) { const alive = party.filter((m) => m.hp > 0); if (!alive.length) break; rng.pick(alive).hp -= s(rng); }
  }
  return { won: hp <= 0, enemyHp: Math.max(0, hp), rounds: r };
}

const flatTable = (arch: any) => lootTable(arch).map((e) => ({ ...e, w: Math.pow(e.w, 0.6) })); // flatter weights => rarer items show up

export function launch(ctx: Ctx, pid: number): Result {
  return tx(ctx.db, () => {
    const { db } = ctx;
    const a = accessOf(db, pid);
    if (!a.canRaid) fail('Only the leader (or trusted raid commanders) can launch.');
    const raid = openRaid(db, a.crew.id) ?? fail('Your crew has no raid lobby open.');
    if (raid.expires_at <= ctx.now()) fail('That lobby has expired.');
    if (raid.starter_id !== pid && !a.owner) fail('Only the organiser or the crew leader can launch.');
    const e = economy(db);
    const rows = db.prepare('SELECT * FROM crew_raid_members WHERE raid_id = ? ORDER BY joined_at').all(raid.id) as any[];
    if (rows.length < e.crew_raid_min_members) fail(`You need at least ${e.crew_raid_min_members} raiders (have ${rows.length}).`);
    const flip = db.prepare("UPDATE crew_raids SET status = 'resolved', resolved_at = ? WHERE id = ? AND status = 'recruiting'").run(ctx.now(), raid.id);
    if (flip.changes === 0) fail('That raid was already launched.');
    return resolveRaid(ctx, raid, rows);
  });
}

function resolveRaid(ctx: Ctx, raid: any, rows: any[]): Result {
  const { db } = ctx;
  const rng = new Rng(raid.seed);
  const city = CITY_BY_ID[raid.city_id];
  const e = economy(db);
  const now = ctx.now();
  const crew = db.prepare('SELECT * FROM crews WHERE id = ?').get(raid.crew_id) as any;
  const party: Fighter[] = rows.map((m) => {
    const p = loadPlayer(ctx, m.player_id);
    const factor = Math.max(0.4, 1 - 0.5 * (m.pen_food + m.pen_water));
    return { p, hp: p.hp, strike: playerStriker(ctx, p), factor };
  });
  const supplyMult = party.reduce((s, f, i) => s + Math.max(0.4, 1 - 0.4 * rows[i].pen_food - 0.4 * rows[i].pen_water), 0) / party.length;
  const ev: string[] = [`👥 **${party.length} raiders** from [${crew.tag}] ${crew.name} move out: ${party.map((f) => f.p.name).join(', ')}.`];
  if (supplyMult < 0.95) ev.push('🥴 Some of you are short on food/water — weaker attacks and less loot.');
  const loot: Record<string, number> = {};
  let victory = false, defenderCrewId: number | null = null, target = raid.target;
  let xpWin = 60 + city.danger * 10;

  if (raid.kind === 'monster') {
    const mo = MONSTERS[raid.target];
    target = mo.id;
    const boss: Enemy = { name: mo.name, hp: mo.hp * 3, strikes: [npcStriker([Math.round(mo.dmg[0] * 1.2), Math.round(mo.dmg[1] * 1.2)]), npcStriker(mo.dmg)] };
    const r = groupFight(rng, party, boss);
    victory = r.won;
    ev.push(victory ? `${mo.emoji} The **${mo.name} nest** falls after ${r.rounds} rounds!` : `${mo.emoji} The **${mo.name}** overwhelms you (it still had ${r.enemyHp}/${boss.hp} HP).`);
    if (victory) {
      const rolls = 3 + party.length;
      for (let i = 0; i < rolls; i++) for (const d of mo.loot) if (rng.chance(Math.min(1, d.chance + 0.25))) addTo(loot, d.item, Math.ceil(rng.int(d.min, d.max) * 1.5 * e.loot_multiplier * supplyMult));
      addTo(loot, 'monster_hide', rng.int(2, 4)); if (rng.chance(0.6)) addTo(loot, rng.pick(['circuit', 'battery']), rng.int(1, 2));
    }
  } else if (raid.kind === 'building') {
    const arch = city.archetype, b = BUILDINGS[arch];
    const waves = city.danger >= 4 ? 3 : 2;
    let cleared = 0;
    for (let w = 0; w < waves; w++) {
      let enemy: Enemy, label_: string;
      if (w % 2 === 0) {
        const mo = rng.pick(eligibleMonsters(city));
        enemy = { name: mo.name, hp: Math.round(mo.hp * 1.5 * (1 + 0.1 * w)), strikes: [npcStriker(mo.dmg)] }; label_ = `${mo.emoji} a ${mo.name}`;
      } else {
        const bd = banditFor(city.danger);
        enemy = { name: bd.name + ' gang', hp: Math.round(bd.hp * 2.5), strikes: [npcStriker(bd.dmg), npcStriker(bd.dmg), npcStriker(bd.dmg)] }; label_ = `🗡️ a gang of ${bd.name}s`;
      }
      const r = groupFight(rng, party, enemy);
      if (!r.won) { ev.push(`Wave ${w + 1}: ${label_} — you were beaten back!`); break; }
      cleared++; ev.push(`Wave ${w + 1}: ${label_} — cleared in ${r.rounds} rounds.`);
    }
    victory = cleared === waves;
    const frac = cleared / waves;
    ev.push(victory ? `${b.emoji} **${b.name}** is yours — nobody has touched this place in decades!` : cleared ? `${b.emoji} You grabbed what you could from the lower floors of ${b.name}.` : `${b.emoji} You never made it into ${b.name}.`);
    if (cleared) {
      const tbl = flatTable(arch), rolls = Math.round((10 + 3 * party.length) * frac);
      for (let i = 0; i < rolls; i++) { const en = rng.weighted(tbl, (t) => t.w); addTo(loot, en.item, Math.ceil(rng.int(en.min, en.max) * 1.25 * e.loot_multiplier * supplyMult)); }
      for (const [it, [lo, hi]] of Object.entries(b.bonus)) addTo(loot, it, Math.ceil(rng.int(lo, hi) * frac * supplyMult));
    }
    xpWin = Math.round(xpWin * 1.3);
  } else {
    // crew vs crew: fight the defenders; if they win, steal from their crew vault
    const def = db.prepare('SELECT c.*, o.home_city_id FROM crews c JOIN players o ON o.id = c.owner_id WHERE c.id = ?').get(Number(raid.target)) as any;
    defenderCrewId = def.id;
    const defenders = (db.prepare(`SELECT p.id FROM crew_members m JOIN players p ON p.id = m.player_id WHERE m.crew_id = ? AND p.hp >= 30
      AND NOT EXISTS (SELECT 1 FROM missions x WHERE x.player_id = p.id AND x.status = 'active') ORDER BY p.level DESC LIMIT 5`).all(def.id) as any[]).map((r) => loadPlayer(ctx, r.id));
    const strikes: ((r: Rng) => number)[] = defenders.map((d) => playerStriker(ctx, d));
    // turrets at defenders' shelters join in (1 power per shot)
    for (const d of defenders) {
      const t = structureLevel(db, d.id, 'turret');
      if (t && d.home_city_id === raid.city_id) for (let i = 0; i < t.quantity; i++) strikes.push((r) => {
        const ok = db.prepare('UPDATE shelters SET power_charge = power_charge - 1 WHERE player_id = ? AND power_charge >= 1').run(d.id).changes > 0;
        return ok && r.chance(0.75) ? turretDamage(t.level) : 0;
      });
    }
    ev.push(`⚔️ Target: crew **[${def.tag}] ${def.name}** — ${defenders.length ? `${defenders.length} defenders stand ready` : 'nobody is home!'}`);
    const r = defenders.length ? groupFight(rng, party, { name: def.name, hp: defenders.reduce((s, d) => s + d.hp, 0), strikes }) : { won: true, enemyHp: 0, rounds: 0 };
    victory = r.won;
    if (victory) {
      const cap = party.length * 30;
      let room = cap;
      for (const it of db.prepare('SELECT item_id, quantity FROM crew_vault WHERE crew_id = ? ORDER BY quantity DESC').all(def.id) as any[]) {
        const take = Math.min(room, Math.max(1, Math.ceil(it.quantity * 0.2)));
        if (take <= 0) break;
        db.prepare('UPDATE crew_vault SET quantity = quantity - ? WHERE crew_id = ? AND item_id = ?').run(take, def.id, it.item_id);
        db.prepare("INSERT INTO crew_vault_log (crew_id,player_id,kind,item_id,quantity,ref,created_at) VALUES (?,NULL,'raid_stolen',?,?,?,?)").run(def.id, it.item_id, take, `raid ${raid.id}`, now);
        addTo(loot, it.item_id, take); room -= take;
      }
      db.prepare('DELETE FROM crew_vault WHERE quantity = 0').run();
      db.prepare('UPDATE crews SET raid_shield_until = ? WHERE id = ?').run(now + e.crew_raid_shield_minutes * MIN, def.id);
      ev.push(Object.keys(loot).length ? `💰 You broke into their hideout and cleaned out part of the crew vault!` : `🕳️ You broke in, but their crew vault was empty.`);
      for (const m of db.prepare('SELECT player_id FROM crew_members WHERE crew_id = ?').all(def.id) as any[])
        notify(ctx, m.player_id, 'raid', `🚨 Crew **[${crew.tag}] ${crew.name}** raided your hideout and stole ${lootText(loot)} from the crew vault! You are shielded for ${e.crew_raid_shield_minutes} min.`);
      for (const f of party) db.prepare('UPDATE players SET karma = karma - 1 WHERE id = ?').run(f.p.id);
    } else {
      ev.push(`🛡️ **[${def.tag}]** repelled your raid!`);
      for (const m of db.prepare('SELECT player_id FROM crew_members WHERE crew_id = ?').all(def.id) as any[]) notify(ctx, m.player_id, 'raid', `🛡️ Your crew drove off a raid by **[${crew.tag}] ${crew.name}**!`);
    }
    // defenders hurt in the fight
    for (const d of defenders) db.prepare('UPDATE players SET hp = MAX(1, hp - ?) WHERE id = ?').run(rng.int(5, 25), d.id);
    xpWin = Math.round(xpWin * 1.2);
  }

  // ---- apply: hp, loot -> crew vault (overflow split among raiders), xp
  const down = party.filter((f) => f.hp <= 0).length;
  for (const f of party) db.prepare('UPDATE players SET hp = ? WHERE id = ?').run(Math.max(1, f.hp), f.p.id);
  if (down) ev.push(`🩸 ${down} raider(s) went down in the fight and limp home at 1 HP.`);
  const stored: Record<string, number> = {}, overflow: Record<string, number> = {};
  for (const [it, n] of Object.entries(loot)) {
    const fit = vaultAdd(ctx, raid.crew_id, it, n, 'raid_loot', null, `raid ${raid.id}`);
    if (fit) stored[it] = fit;
    if (fit < n) overflow[it] = n - fit;
  }
  let i = 0;
  for (const [it, n] of Object.entries(overflow)) for (let k = 0; k < n; k++) addItem(db, party[i++ % party.length].p.id, it, 1);
  if (Object.keys(overflow).length) ev.push(`📦 The crew vault was full — ${lootText(overflow)} was split between the raiders.`);
  const lvlLines: string[] = [];
  for (const f of party) lvlLines.push(...addXp(ctx, f.p.id, victory ? xpWin : Math.round(xpWin / 3)).map((l) => `${f.p.name}: ${l}`));
  ev.push(...lvlLines);
  db.prepare('INSERT INTO crew_raid_log (raid_id,crew_id,kind,target,defender_crew_id,city_id,outcome,loot_json,events_json,members_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(raid.id, raid.crew_id, raid.kind, target, defenderCrewId, raid.city_id, victory ? 'victory' : 'defeat', JSON.stringify(loot), JSON.stringify(ev), JSON.stringify(party.map((f) => f.p.name)), now);
  for (const f of party) notify(ctx, f.p.id, 'crew', `${victory ? '🏆' : '💀'} Crew raid ${victory ? 'VICTORY' : 'defeat'} — loot${Object.keys(loot).length ? ` sent to the crew vault: ${lootText(loot)}` : ': none'}.`);
  log.info(`${victory ? '🏆' : '💀'} [crewraid] [${crew.tag}] ${raid.kind} raid in ${city.name}: ${victory ? 'VICTORY' : 'DEFEAT'} with ${party.length} raiders, loot ${lootText(loot)}`);
  return result(victory ? 'Crew raid — VICTORY!' : 'Crew raid — defeat', [...ev, '', `📦 Loot → crew vault: ${lootText(loot)}`, victory ? '🔑 The leader can hand it out with `/crew reward`.' : ''].filter((x) => x !== undefined), { victory, loot, events: ev });
}
