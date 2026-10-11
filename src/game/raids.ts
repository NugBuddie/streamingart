import { type Ctx, fail, result, type Result } from './ctx.js';
import { loadPlayer, shelterOf, structureLevel, economy, notify, addItem, addTo, lootText, inventory, equipmentOf, isCriminal, type PlayerRow } from './store.js';
import { crewBonus, areCrewmates } from './crews.js';
import { playerStriker } from './combat.js';
import { bestWeapon } from './store.js';
import { Rng, freshSeed } from './rng.js';
import { CITY_BY_ID } from '../data/world.js';
import { ITEMS, label } from '../data/items.js';
import { MIN, doorMaxHp, turretDamage, turretHp, bagCapacity, robotBag } from '../data/progression.js';
import { tx } from '../db/index.js';
import { log as logger } from '../logger.js';

/**
 * PvP shelter raid. Phases: traps -> turrets (+home robot) -> door -> loot.
 * Vault contents and Void Coins are never lootable. Turrets cost 1 power per shot; strong weapons (rifle, bat) wreck turrets and doors faster.
 */
export function raid(ctx: Ctx, attackerId: number, target: PlayerRow): Result {
  return tx(ctx.db, () => {
    const { db } = ctx;
    const e = economy(db);
    const now = ctx.now();
    const a = loadPlayer(ctx, attackerId);
    const t = loadPlayer(ctx, target.id);
    if (a.id === t.id) return fail('You cannot raid yourself.');
    if (areCrewmates(db, a.id, t.id)) return fail('You do not raid your own crew.');
    if (db.prepare("SELECT 1 FROM missions WHERE player_id = ? AND status = 'active'").get(a.id)) return fail('Finish your mission first.');
    if (a.city_id !== t.home_city_id) return fail(`${t.name}'s shelter is in **${CITY_BY_ID[t.home_city_id].name}**. Travel there first (you are in ${CITY_BY_ID[a.city_id].name}).`);
    if (a.hp < 30) return fail('You are too hurt to raid (HP < 30).');
    if (a.energy < e.raid_energy_cost) return fail(`A raid costs ${e.raid_energy_cost}⚡ energy.`);
    if (t.protected_until > now) return fail(`${t.name} is under new-player protection for ${Math.ceil((t.protected_until - now) / MIN)} more min.`);
    if (t.raid_shield_until > now) return fail(`${t.name}'s shelter was just raided and is shielded for ${Math.ceil((t.raid_shield_until - now) / MIN)} min.`);
    const last = db.prepare("SELECT created_at FROM attack_log WHERE kind = 'raid' AND attacker_id = ? AND defender_id = ? ORDER BY id DESC LIMIT 1").get(a.id, t.id) as any;
    if (last && now - last.created_at < e.raid_cooldown_minutes * MIN) return fail(`You raided ${t.name} recently. Cooldown: ${Math.ceil((e.raid_cooldown_minutes * MIN - (now - last.created_at)) / MIN)} min.`);

    db.prepare('UPDATE players SET energy = energy - ?, protected_until = 0 WHERE id = ?').run(e.raid_energy_cost, a.id);
    const rng = new Rng(freshSeed());
    const sh = shelterOf(db, t.id);
    const crew = crewBonus(db, a.id);
    const strike = playerStriker(ctx, a, 1 + crew.raidBonus);
    const breachMult = () => 0.5 + bestWeapon(db, a.id).stats.breach;
    const log: string[] = [`⚔️ **${a.name}** (${bestWeapon(db, a.id).name}) moves on **${t.name}**'s shelter in ${CITY_BY_ID[t.home_city_id].name}.`];
    let hp = a.hp, power = sh.power_charge, destroyed = 0, trapsHit = 0;

    // --- traps
    const trapQty = structureLevel(db, t.id, 'trap')?.quantity ?? 0;
    for (let i = 0; i < trapQty; i++) if (rng.chance(0.7)) { hp -= rng.int(12, 20); trapsHit++; }
    if (trapsHit) { db.prepare("UPDATE shelter_structures SET quantity = quantity - ? WHERE player_id = ? AND structure = 'trap'").run(trapsHit, t.id); log.push(`🪤 ${trapsHit} spike trap(s) sprung (they are used up). You're at ${Math.max(0, hp)} HP.`); }

    // --- turrets + robot
    const tl = structureLevel(db, t.id, 'turret');
    const turrets = tl ? Array.from({ length: tl.quantity }, () => turretHp(tl.level)) : [];
    const robot = db.prepare("SELECT * FROM robots WHERE player_id = ? AND mode = 'home' AND durability > 0").get(t.id) as any;
    let robotRounds = 0;
    for (let round = 1; round <= 4 && hp > 0 && turrets.some((x) => x > 0); round++) {
      for (let i = 0; i < turrets.length; i++) {
        if (turrets[i] <= 0 || power < 1) continue;
        power--;
        if (rng.chance(0.75)) hp -= turretDamage(tl!.level);
      }
      if (robot && rng.chance(0.8)) { hp -= 6 + 3 * robot.level; robotRounds++; }
      if (hp <= 0) break;
      const target_ = turrets.findIndex((x, i) => x > 0 && x === Math.min(...turrets.filter((y) => y > 0)));
      if (target_ >= 0) { turrets[target_] -= Math.round(strike(rng) * breachMult()); if (turrets[target_] <= 0) destroyed++; }
    }
    if (tl) {
      const unpowered = power < 1 && turrets.some((x) => x > 0);
      log.push(`🤖 Turrets: ${tl.quantity} defending → ${destroyed} destroyed${unpowered ? ' (the rest ran out of power!)' : ''}.`);
      db.prepare("UPDATE shelter_structures SET quantity = quantity - ? WHERE player_id = ? AND structure = 'turret'").run(destroyed, t.id);
      db.prepare('UPDATE shelters SET power_charge = ? WHERE player_id = ?').run(power, t.id);
    }
    if (robotRounds) { db.prepare('UPDATE robots SET durability = MAX(0, durability - ?) WHERE player_id = ?').run(2 * robotRounds, t.id); log.push(`🤖 The home Scav-Bot zapped you ${robotRounds}×.`); }

    const finish = (outcome: 'success' | 'failed' | 'defeated', loot: Record<string, number>, doorBroken: boolean): Result => {
      const lost = a.hp - Math.max(1, hp);
      db.prepare('UPDATE players SET hp = ?, karma = karma + ? WHERE id = ?').run(Math.max(1, hp), outcome === 'success' ? (isCriminal(t) ? 1 : -2) : -1, a.id);
      const lid = Number(db.prepare('INSERT INTO attack_log (kind,attacker_id,defender_id,city_id,outcome,turrets_destroyed,door_broken,loot_json,attacker_hp_lost,details,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run('raid', a.id, t.id, t.home_city_id, outcome, destroyed, doorBroken ? 1 : 0, JSON.stringify(loot), lost, JSON.stringify(log), now).lastInsertRowid);
      db.prepare("INSERT INTO shelter_event_log (player_id,kind,delta_hp,event_key,details,created_at) VALUES (?,'raid',?,?,?,?)").run(t.id, 0, `raid:${lid}`, JSON.stringify({ attacker: a.name, outcome }), now);
      logger.info(`⚔️ [pvp] RAID ${a.name} → ${t.name}: ${outcome.toUpperCase()}${outcome === 'success' ? `, stole ${lootText(loot)}` : ''}, ${destroyed} turret(s) destroyed`);
      notify(ctx, t.id, 'raid', outcome === 'success'
        ? `🚨 **${a.name}** raided your shelter! Door broken, ${destroyed} turret(s) lost. They stole ${lootText(loot)}. (Your vault was safe.)`
        : outcome === 'defeated' ? `🛡️ **${a.name}** attacked your shelter but your defenses took them down!${Object.keys(loot).length ? ` You scavenged ${lootText(loot)} from them.` : ''}`
        : `🛡️ **${a.name}** attacked your shelter but couldn't break the door. ${destroyed} turret(s) destroyed.`);
      return result(outcome === 'success' ? 'Raid successful!' : outcome === 'defeated' ? 'Raid failed — you were driven off!' : 'Raid failed', log, { outcome, loot, attackLogId: lid });
    };

    if (hp <= 0) {
      const dropped: Record<string, number> = {};
      for (const [k, n] of Object.entries(inventory(db, a.id))) { const d = Math.floor(n * 0.25); if (d > 0) { db.prepare('UPDATE player_inventory SET quantity = quantity - ? WHERE player_id = ? AND item_id = ?').run(d, a.id, k); addItem(db, t.id, k, d); dropped[k] = d; } }
      log.push('💀 Your body hits the dirt. Defenses win — you limp away having dropped some supplies.');
      return finish('defeated', dropped, false);
    }

    // --- door
    const weak = sh.hp < sh.max_hp * 0.25 ? 0.5 : 1;
    let doorHp = sh.door_hp * weak;
    const startDoor = doorHp;
    for (let r = 0; r < 5 && doorHp > 0; r++) doorHp -= strike(rng) * breachMult();
    const broken = doorHp <= 0;
    db.prepare('UPDATE shelters SET door_hp = ? WHERE player_id = ?').run(broken ? 0 : Math.max(1, Math.round(doorHp / weak)), t.id);
    log.push(broken ? `🚪 You smash through the door (L${sh.door_level}, ${Math.round(startDoor)} HP)!` : `🚪 The L${sh.door_level} door holds (${Math.max(1, Math.round(doorHp))} HP left). You retreat.`);
    if (!broken) return finish('failed', {}, false);

    // --- loot (only items OUTSIDE the vault; never Void Coins)
    const cap = bagCapacity(a.level, loadShelterLevel(ctx, a.id)) + (robotCap(ctx, a.id));
    const stolen: Record<string, number> = {};
    let room = cap;
    const stacks = Object.entries(inventory(db, t.id)).sort((x, y) => ITEMS[y[0]].value - ITEMS[x[0]].value);
    for (const [k, n] of stacks) {
      const take = Math.min(room, Math.max(1, Math.ceil(n * 0.3)));
      if (take <= 0) break;
      db.prepare('UPDATE player_inventory SET quantity = quantity - ? WHERE player_id = ? AND item_id = ?').run(take, t.id, k);
      addTo(stolen, k, take); room -= take;
    }
    db.prepare('DELETE FROM player_inventory WHERE player_id = ? AND quantity = 0').run(t.id);
    const gear = equipmentOf(db, t.id).filter((x) => x.location === 'bag' && !x.equipped);
    if (gear.length && rng.chance(0.3)) {
      const g = rng.pick(gear);
      db.prepare('UPDATE player_equipment SET player_id = ?, equipped = 0, location = ? WHERE id = ?').run(a.id, 'bag', g.id);
      log.push(`🔫 You also grab their ${label(g.item_id)}!`);
    }
    for (const [k, n] of Object.entries(stolen)) addItem(db, a.id, k, n);
    const dmg = rng.int(10, 25);
    db.prepare('UPDATE shelters SET hp = MAX(0, hp - ?) WHERE player_id = ?').run(dmg, t.id);
    db.prepare('UPDATE players SET raid_shield_until = ? WHERE id = ?').run(now + e.raid_shield_minutes * MIN, t.id);
    log.push(`📦 Loot: ${lootText(stolen)}. The vault door stays sealed. ${isCriminal(t) ? 'You raided a known criminal (+1 karma).' : '🏴 Raiding an honest scavenger costs you karma (-2).'}`);
    return finish('success', stolen, true);
  });
}
const loadShelterLevel = (ctx: Ctx, pid: number) => shelterOf(ctx.db, pid).level;
const robotCap = (ctx: Ctx, pid: number) => {
  const r = ctx.db.prepare("SELECT level FROM robots WHERE player_id = ? AND mode = 'mission' AND durability > 0").get(pid) as any;
  return r ? robotBag(r.level) : 0;
};

export function defenseView(ctx: Ctx, pid: number): Result {
  const { db } = ctx;
  const sh = shelterOf(db, pid);
  const tl = structureLevel(db, pid, 'turret'), tr = structureLevel(db, pid, 'trap');
  const robot = db.prepare('SELECT * FROM robots WHERE player_id = ?').get(pid) as any;
  const p = loadPlayer(ctx, pid);
  const now = ctx.now();
  const recent = db.prepare(`SELECT a.*, pa.name AS attacker, pd.name AS defender FROM attack_log a JOIN players pa ON pa.id = a.attacker_id JOIN players pd ON pd.id = a.defender_id
    WHERE a.attacker_id = ? OR a.defender_id = ? ORDER BY a.id DESC LIMIT 5`).all(pid, pid) as any[];
  const monsters = db.prepare("SELECT monster_id, outcome, created_at FROM monster_attack_log WHERE player_id = ? AND context = 'shelter' ORDER BY id DESC LIMIT 3").all(pid) as any[];
  return result('Shelter defenses', [
    `🚪 Door L${sh.door_level}: ${sh.door_hp}/${doorMaxHp(sh.door_level)} HP${sh.door_hp === 0 ? ' ❌ BROKEN — repair it!' : ''}`,
    `🤖 Turrets: ${tl ? `${tl.quantity} × L${tl.level} (${turretDamage(tl.level)} dmg, 1⚡ per shot)` : 'none'} · 🪤 Traps: ${tr?.quantity ?? 0} · ⚡ Power: ${sh.power_charge}${tl && sh.power_charge < 4 * tl.quantity ? ' ⚠️ low' : ''}`,
    `🛰️ Home robot: ${robot ? (robot.mode === 'home' && robot.durability > 0 ? `on guard (L${robot.level})` : 'not on guard') : 'none'}`,
    `🛡️ ${p.protected_until > now ? `New-player protection ${Math.ceil((p.protected_until - now) / MIN)} min` : p.raid_shield_until > now ? `Raid shield ${Math.ceil((p.raid_shield_until - now) / MIN)} min` : 'No shield — you can be raided'}`,
    '🔒 Items in the vault are raid-proof. Everything else in your pockets is fair game.',
    '', '**Recent fights**',
    ...(recent.length ? recent.map((r) => `${r.kind === 'ambush' ? '🏴' : '⚔️'} ${r.attacker} → ${r.defender}: ${r.outcome} · <t:${Math.floor(r.created_at / 1000)}:R>`) : ['—']),
    ...(monsters.length ? ['', '**Monster attacks**', ...monsters.map((m) => `🐾 ${m.monster_id}: ${m.outcome} · <t:${Math.floor(m.created_at / 1000)}:R>`)] : []),
  ], { shelter: sh, turret: tl ?? null, traps: tr?.quantity ?? 0, recent });
}
