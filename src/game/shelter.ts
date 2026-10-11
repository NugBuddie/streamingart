import { randomUUID } from 'node:crypto';
import { type Ctx, fail, result, type Result } from './ctx.js';
import { loadPlayer, shelterOf, structureLevel, pay, fmtCost, qty, takeItem, hasStructure, type PlayerRow } from './store.js';
import { UPGRADES, doorMaxHp, shelterMaxHp, powerCapacity, turretDamage, turretHp, VAULT_CAPACITY } from '../data/progression.js';
import { STRUCTURE_NAMES } from '../data/recipes.js';
import { CITY_BY_ID } from '../data/world.js';
import { tx } from '../db/index.js';

/** Shelter-bound actions only work in your home city. */
export function requireHome(p: PlayerRow): void {
  if (p.city_id !== p.home_city_id) fail(`Your shelter is in ${CITY_BY_ID[p.home_city_id].name}. Travel home first.`);
}

export function view(ctx: Ctx, pid: number): Result {
  const { db } = ctx;
  const p = loadPlayer(ctx, pid);
  const sh = shelterOf(db, pid);
  const st = db.prepare('SELECT structure, level, quantity FROM shelter_structures WHERE player_id = ? AND quantity > 0').all(pid) as any[];
  const lines = [
    `📍 ${CITY_BY_ID[sh.city_id].name}${p.city_id !== p.home_city_id ? ' (you are away)' : ''}`,
    `🏚️ Shelter **L${sh.level}** — ${sh.hp}/${sh.max_hp} HP`,
    `🚪 Door **L${sh.door_level}** — ${sh.door_hp}/${doorMaxHp(sh.door_level)} HP${sh.door_hp === 0 ? ' ❌ BROKEN' : ''}`,
    `🔒 Vault **L${sh.vault_level}** — capacity ${VAULT_CAPACITY[sh.vault_level]}`,
    `⚡ Power ${sh.power_charge}/${hasStructure(db, pid, 'power_bank') ? powerCapacity(structureLevel(db, pid, 'power_bank')!.level) : 0}`,
    '',
    '**Structures**',
    ...st.map((s) => `${STRUCTURE_NAMES[s.structure] ?? s.structure}${s.quantity > 1 ? ` ×${s.quantity}` : ''} (L${s.level})${s.structure === 'turret' ? ` — ${turretDamage(s.level)} dmg, ${turretHp(s.level)} HP each` : ''}`),
    '',
    '**Upgrades** (`/shelter upgrade <target>`)',
    ...Object.entries(UPGRADES).map(([k, u]) => {
      const lv = currentLevel(ctx, pid, k);
      return lv === null ? `• ${k}: build it first` : lv >= u.max ? `• ${k}: L${lv} (max)` : `• ${k}: L${lv} → L${lv + 1}: ${fmtCost(u.cost(lv))}`;
    }),
  ];
  const events = db.prepare('SELECT kind, delta_hp, created_at FROM shelter_event_log WHERE player_id = ? ORDER BY id DESC LIMIT 5').all(pid) as any[];
  return result('Your shelter', lines, { shelter: sh, structures: st, events });
}

function currentLevel(ctx: Ctx, pid: number, target: string): number | null {
  const { db } = ctx;
  switch (target) {
    case 'shelter': return shelterOf(db, pid).level;
    case 'door': return shelterOf(db, pid).door_level;
    case 'vault': return shelterOf(db, pid).vault_level;
    case 'power_bank': case 'turret': return structureLevel(db, pid, target)?.level ?? null;
    case 'robot': return (db.prepare('SELECT level FROM robots WHERE player_id = ?').get(pid) as any)?.level ?? null;
  }
  return null;
}

export function upgrade(ctx: Ctx, pid: number, target: string): Result {
  const u = UPGRADES[target];
  if (!u) return fail(`Unknown upgrade. Options: ${Object.keys(UPGRADES).join(', ')}`);
  return tx(ctx.db, () => {
    const { db } = ctx;
    const p = loadPlayer(ctx, pid);
    requireHome(p);
    const lv = currentLevel(ctx, pid, target);
    if (lv === null) return fail(`You haven't built a ${target.replace('_', ' ')} yet.`);
    if (lv >= u.max) return fail(`${target} is already at max level.`);
    const cost = u.cost(lv);
    pay(ctx, pid, cost, 'upgrade');
    const to = lv + 1;
    const now = ctx.now();
    if (target === 'shelter') {
      const d = shelterMaxHp(to) - shelterMaxHp(lv);
      db.prepare('UPDATE shelters SET level = ?, max_hp = ?, hp = hp + ? WHERE player_id = ?').run(to, shelterMaxHp(to), d, pid);
    } else if (target === 'door') {
      const d = doorMaxHp(to) - doorMaxHp(lv);
      db.prepare('UPDATE shelters SET door_level = ?, door_hp = door_hp + ? WHERE player_id = ?').run(to, d, pid);
    } else if (target === 'vault') db.prepare('UPDATE shelters SET vault_level = ? WHERE player_id = ?').run(to, pid);
    else if (target === 'robot') {
      const nm = 100 + 50 * to;
      db.prepare('UPDATE robots SET level = ?, max_durability = ?, durability = ? WHERE player_id = ?').run(to, nm, nm, pid);
    } else db.prepare('UPDATE shelter_structures SET level = ? WHERE player_id = ? AND structure = ?').run(to, pid, target);
    db.prepare('INSERT INTO upgrade_log (player_id,target,from_level,to_level,cost_json,created_at) VALUES (?,?,?,?,?,?)').run(pid, target, lv, to, JSON.stringify(cost), now);
    db.prepare("INSERT INTO shelter_event_log (player_id,kind,delta_hp,event_key,details,created_at) VALUES (?,'upgrade',0,?,?,?)").run(pid, `upgrade:${target}:${to}`, JSON.stringify({ target, to }), now);
    return result('Upgraded', [`✅ ${target} upgraded to **L${to}** for ${fmtCost(cost)}.`]);
  });
}

/** Repair shelter or door with scrap parts (shelter: 5 HP/scrap; door: 8 HP/scrap + 1 iron ingot per 40 HP). */
export function repair(ctx: Ctx, pid: number, target: 'shelter' | 'door'): Result {
  return tx(ctx.db, () => {
    const { db } = ctx;
    const p = loadPlayer(ctx, pid);
    requireHome(p);
    const sh = shelterOf(db, pid);
    const missingHp = target === 'shelter' ? sh.max_hp - sh.hp : doorMaxHp(sh.door_level) - sh.door_hp;
    if (missingHp <= 0) return fail(`Your ${target} is in perfect shape.`);
    const perScrap = target === 'shelter' ? 5 : 8;
    let hp = Math.min(missingHp, qty(db, pid, 'scrap') * perScrap);
    if (target === 'door') hp = Math.min(hp, (qty(db, pid, 'iron_ingot') + 1) * 40); // first 40 HP need no iron
    if (hp <= 0) return fail('You need scrap to repair (door repairs also use iron ingots).');
    const scrap = Math.ceil(hp / perScrap);
    const iron = target === 'door' ? Math.max(0, Math.ceil(hp / 40) - 1) : 0;
    pay(ctx, pid, { scrap, ...(iron ? { iron_ingot: iron } : {}) }, 'repair');
    db.prepare(`UPDATE shelters SET ${target === 'shelter' ? 'hp' : 'door_hp'} = ${target === 'shelter' ? 'hp' : 'door_hp'} + ? WHERE player_id = ?`).run(hp, pid);
    db.prepare("INSERT INTO shelter_event_log (player_id,kind,delta_hp,event_key,details,created_at) VALUES (?,'repair',?,?,?,?)")
      .run(pid, hp, `repair:${randomUUID()}`, JSON.stringify({ target, scrap, iron }), ctx.now());
    return result('Repaired', [`🔧 Repaired ${target} by ${hp} HP using ${fmtCost({ scrap, ...(iron ? { iron_ingot: iron } : {}) })}.`]);
  });
}

/** Convert batteries (+10 power each) into stored power. */
export function charge(ctx: Ctx, pid: number, batteries: number): Result {
  batteries = Math.max(1, Math.floor(batteries));
  return tx(ctx.db, () => {
    const { db } = ctx;
    requireHome(loadPlayer(ctx, pid));
    const bank = structureLevel(db, pid, 'power_bank');
    if (!bank) return fail('Build a power bank first (`/craft make power_bank`).');
    const cap = powerCapacity(bank.level), sh = shelterOf(db, pid);
    const usable = Math.min(batteries, Math.floor((cap - sh.power_charge) / 10));
    if (usable <= 0) return fail(`Power bank is full (${sh.power_charge}/${cap}).`);
    takeItem(db, pid, 'battery', usable);
    db.prepare('UPDATE shelters SET power_charge = power_charge + ? WHERE player_id = ?').run(usable * 10, pid);
    return result('Charged', [`🔋 Used ${usable} batteries: power ${sh.power_charge + usable * 10}/${cap}.`]);
  });
}

/** Discharge 10 power into 25 energy. */
export function discharge(ctx: Ctx, pid: number, times = 1): Result {
  times = Math.max(1, Math.floor(times));
  return tx(ctx.db, () => {
    const { db } = ctx;
    const p = loadPlayer(ctx, pid);
    requireHome(p);
    const sh = shelterOf(db, pid);
    const n = Math.min(times, Math.floor(sh.power_charge / 10), Math.ceil((p.max_energy - p.energy) / 25));
    if (n <= 0) return fail(p.energy >= p.max_energy ? 'Your energy is already full.' : 'Not enough stored power (need 10).');
    db.prepare('UPDATE shelters SET power_charge = power_charge - ? WHERE player_id = ?').run(n * 10, pid);
    db.prepare('UPDATE players SET energy = MIN(max_energy, energy + ?) WHERE id = ?').run(n * 25, pid);
    return result('Recharged', [`⚡ Drew ${n * 10} power: +${Math.min(n * 25, p.max_energy - p.energy)} energy.`]);
  });
}
