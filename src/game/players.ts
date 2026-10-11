import { type Ctx, fail, result, type Result } from './ctx.js';
import {
  loadPlayer, shelterOf, addItem, takeItem, inventory, equipmentOf, addEquipment, bar,
  vaultUsed, vaultCapacity, isCriminal, economy,
} from './store.js';
import { CITY_BY_ID, CITIES, REGIONS, START_CITIES, findCity, travelCost } from '../data/world.js';
import { ITEMS, label, findItem, isEquipment } from '../data/items.js';
import { PLAYER, maxHpFor, xpForNext, shelterMaxHp, doorMaxHp, MIN, bagCapacity, robotBag } from '../data/progression.js';
import { Rng, freshSeed } from './rng.js';
import { tx } from '../db/index.js';
import { requireHome } from './shelter.js';

export function register(ctx: Ctx, opts: { name: string; discordId?: string; city?: string }): Result {
  const name = opts.name.trim();
  if (!/^[A-Za-z0-9_][A-Za-z0-9_ ]{1,22}[A-Za-z0-9_]$/.test(name)) fail('Name must be 3-24 characters: letters, numbers, spaces or underscores.');
  return tx(ctx.db, () => {
    const { db } = ctx;
    if (opts.discordId && db.prepare('SELECT 1 FROM players WHERE discord_id = ?').get(opts.discordId)) fail('You are already registered. Use /status.');
    if (db.prepare('SELECT 1 FROM players WHERE name = ?').get(name)) fail('That name is taken.');
    const chosen = opts.city ? findCity(opts.city) : undefined;
    const cityId = chosen && START_CITIES.includes(chosen.id) ? chosen.id : START_CITIES[Math.floor(Math.random() * START_CITIES.length)];
    const now = ctx.now();
    const maxHp = maxHpFor(1);
    const pid = Number(db.prepare(`INSERT INTO players (discord_id,name,city_id,home_city_id,hp,max_hp,energy,food,water,protected_until,last_energy_at,created_at,last_seen_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(opts.discordId ?? null, name, cityId, cityId, maxHp, maxHp, PLAYER.startEnergy, PLAYER.startFood, PLAYER.startWater,
      now + economy(db).newbie_protect_minutes * MIN, now, now, now).lastInsertRowid);
    db.prepare('INSERT INTO shelters (player_id,city_id,hp,max_hp,door_hp,updated_at) VALUES (?,?,?,?,?,?)').run(pid, cityId, shelterMaxHp(1), shelterMaxHp(1), doorMaxHp(1), now);
    db.prepare("INSERT INTO shelter_structures (player_id,structure,level,quantity) VALUES (?,'workbench',1,1)").run(pid);
    for (const [i, n] of Object.entries(PLAYER.startItems)) addItem(db, pid, i, n);
    addEquipment(ctx, pid, 'bat');
    return result(`Welcome, ${name}!`, [
      `You wake in **${CITY_BY_ID[cityId].name}** (${CITY_BY_ID[cityId].region}). Your shelter is a patched-up basement with a workbench.`,
      'Try `/status`, then `/mission start`, and `/craft list` to see what you can build.',
      `🛡️ New-player protection: ${economy(db).newbie_protect_minutes} minutes without raids.`,
    ], { playerId: pid });
  });
}

export function addXp(ctx: Ctx, pid: number, xp: number): string[] {
  const out: string[] = [];
  const p = loadPlayer(ctx, pid);
  let lvl = p.level, cur = p.xp + xp;
  while (lvl < 50 && cur >= xpForNext(lvl)) { cur -= xpForNext(lvl); lvl++; }
  const maxHp = maxHpFor(lvl);
  ctx.db.prepare('UPDATE players SET xp = ?, level = ?, max_hp = ?, hp = CASE WHEN ? > level THEN ? ELSE hp END WHERE id = ?').run(cur, lvl, maxHp, lvl, maxHp, pid);
  if (lvl > p.level) out.push(`⭐ Level up! You are now level **${lvl}** (max HP ${maxHp}).`);
  return out;
}

export function status(ctx: Ctx, pid: number): Result {
  const { db } = ctx;
  const p = loadPlayer(ctx, pid);
  db.prepare('UPDATE players SET last_seen_at = ? WHERE id = ?').run(ctx.now(), pid);
  const sh = shelterOf(db, pid);
  const city = CITY_BY_ID[p.city_id];
  const mission = db.prepare("SELECT * FROM missions WHERE player_id = ? AND status = 'active'").get(pid) as any;
  const crew = db.prepare('SELECT c.name, c.tag FROM crew_members m JOIN crews c ON c.id = m.crew_id WHERE m.player_id = ?').get(pid) as any;
  const robot = db.prepare('SELECT * FROM robots WHERE player_id = ?').get(pid) as any;
  const weapon = db.prepare("SELECT item_id FROM player_equipment WHERE player_id = ? AND equipped = 1 AND location = 'bag'").get(pid) as any;
  const inv = inventory(db, pid);
  const units = Object.values(inv).reduce((a, b) => a + b, 0);
  const now = ctx.now();
  const lines = [
    `📍 **${city.name}** · ${city.region} · danger ${'⚠️'.repeat(city.danger)}${p.city_id !== p.home_city_id ? ` (home: ${CITY_BY_ID[p.home_city_id].name})` : ''}`,
    `❤️ HP      ${bar(p.hp, p.max_hp)} ${p.hp}/${p.max_hp}`,
    `⚡ Energy  ${bar(p.energy, p.max_energy)} ${p.energy}/${p.max_energy}`,
    `🍖 Food    ${bar(p.food, p.max_food)} ${p.food}/${p.max_food}`,
    `💧 Water   ${bar(p.water, p.max_water)} ${p.water}/${p.max_water}`,
    `⭐ Level ${p.level} (${p.xp}/${xpForNext(p.level)} xp) · 🪙 ${p.void_coins} Void Coins${isCriminal(p) ? ' · 🏴 **Criminal**' : ''}`,
    `🏚️ Shelter L${sh.level}: ${sh.hp}/${sh.max_hp} HP · door ${sh.door_hp}/${doorMaxHp(sh.door_level)} · ⚡ power ${sh.power_charge}`,
    `🎒 ${units} carried units in ${Object.keys(inv).length} stacks · vault ${vaultUsed(db, pid)}/${vaultCapacity(db, pid)} · weapon: ${weapon ? label(weapon.item_id) : '—'}`,
  ];
  if (robot) lines.push(`🤖 Scav-Bot L${robot.level} (${robot.mode === 'mission' ? 'on missions' : 'guarding home'}) ${robot.durability}/${robot.max_durability}`);
  if (crew) lines.push(`👥 Crew [${crew.tag}] ${crew.name}`);
  if (mission) lines.push(mission.ends_at <= now ? '🧭 **Mission finished!** Use `/mission report`.' : `🧭 Mission in ${CITY_BY_ID[mission.city_id].name}: ${Math.ceil((mission.ends_at - now) / MIN)} min left.`);
  if (p.protected_until > now) lines.push(`🛡️ New-player protection for ${Math.ceil((p.protected_until - now) / MIN)} more min.`);
  else if (p.raid_shield_until > now) lines.push(`🛡️ Raid shield for ${Math.ceil((p.raid_shield_until - now) / MIN)} more min.`);
  if (p.food < 15 || p.water < 15) lines.push('⚠️ **You are running low on food/water** — missions will suffer penalties.');
  return result(`${p.name}'s status`, lines, {
    player: p, shelter: sh, city, mission: mission ?? null, crew: crew ?? null, robot: robot ?? null, weapon: weapon?.item_id ?? null, carried: units,
    bagCapacity: bagCapacity(p.level, sh.level) + (robot?.mode === 'mission' ? robotBag(robot.level) : 0),
  });
}

export function inventoryView(ctx: Ctx, pid: number): Result {
  const { db } = ctx;
  const inv = inventory(db, pid);
  const eq = equipmentOf(db, pid);
  const vault = db.prepare('SELECT item_id, quantity FROM vault_contents WHERE player_id = ?').all(pid) as any[];
  const stacks = Object.entries(inv).sort().map(([i, n]) => label(i, n));
  const lines = ['**Carried (at risk in raids)**', ...(stacks.length ? stacks : ['—'])];
  const bag = eq.filter((e) => e.location === 'bag');
  lines.push('', '**Gear**', ...(bag.length ? bag.map((e) => `\`#${e.id}\` ${label(e.item_id)} ${e.durability}/${e.max_durability}${e.equipped ? ' ✅ equipped' : ''}`) : ['—']));
  const vEq = eq.filter((e) => e.location === 'vault');
  lines.push('', `**Vault (${vaultUsed(db, pid)}/${vaultCapacity(db, pid)})** 🔒`,
    ...(vault.length || vEq.length ? [...vault.map((v) => label(v.item_id, v.quantity)), ...vEq.map((e) => `\`#${e.id}\` ${label(e.item_id)} ${e.durability}/${e.max_durability}`)] : ['—']));
  return result('Inventory', lines, { inventory: inv, equipment: eq, vault });
}

/** Eat / drink / heal. Dirty water & raw meat can make you sick. */
export function use(ctx: Ctx, pid: number, itemQ: string, n = 1): Result {
  const d = findItem(itemQ);
  if (!d) return fail(`Unknown item "${itemQ}".`);
  if (!(d.food || d.water || d.hp || d.energy)) return fail(`${label(d.id)} can't be consumed.`);
  n = Math.max(1, Math.floor(n));
  return tx(ctx.db, () => {
    const p = loadPlayer(ctx, pid);
    takeItem(ctx.db, pid, d.id, n);
    const rng = new Rng(freshSeed());
    let food = 0, water = 0, energy = 0, hp = 0, sick = 0;
    for (let i = 0; i < n; i++) {
      food += d.food ?? 0; water += d.water ?? 0; energy += d.energy ?? 0; hp += d.hp ?? 0;
      if (d.sickChance && rng.chance(d.sickChance)) sick += 10;
    }
    const np = {
      food: Math.min(p.max_food, p.food + food), water: Math.min(p.max_water, p.water + water),
      energy: Math.min(p.max_energy, p.energy + energy), hp: Math.max(1, Math.min(p.max_hp, p.hp + hp - sick)),
    };
    ctx.db.prepare('UPDATE players SET food=?, water=?, energy=?, hp=? WHERE id=?').run(np.food, np.water, np.energy, np.hp, pid);
    const parts = [food && `+${np.food - p.food} food`, water && `+${np.water - p.water} water`, energy && `+${np.energy - p.energy} energy`, hp && `+${Math.max(0, np.hp - p.hp + sick)} HP`].filter(Boolean);
    const lines = [`You use ${label(d.id, n)}: ${parts.join(', ') || 'nothing happens'}.`];
    if (sick) lines.push(`🤢 It made you sick: -${sick} HP. (Purify water / cook meat first!)`);
    if (d.id === 'dirty_water') lines.push('💡 Tip: a water purifier turns dirty water into clean water.');
    return result('Consumed', lines);
  });
}

export function equip(ctx: Ctx, pid: number, ref: string): Result {
  const { db } = ctx;
  const id = Number(String(ref).replace('#', ''));
  const row = Number.isFinite(id) && id > 0
    ? db.prepare("SELECT * FROM player_equipment WHERE id = ? AND player_id = ? AND location = 'bag'").get(id, pid) as any
    : db.prepare("SELECT * FROM player_equipment WHERE player_id = ? AND item_id = ? AND location = 'bag' ORDER BY durability DESC").get(pid, findItem(String(ref))?.id ?? '') as any;
  if (!row) return fail('No such gear in your bag. See /inventory.');
  if (!ITEMS[row.item_id].weapon) return fail('Only weapons can be equipped (tools like the ratchet are used automatically).');
  tx(db, () => { db.prepare('UPDATE player_equipment SET equipped = 0 WHERE player_id = ?').run(pid); db.prepare('UPDATE player_equipment SET equipped = 1 WHERE id = ?').run(row.id); });
  return result('Equipped', [`You ready your ${label(row.item_id)}.`]);
}

// ------------------------------------------------------------------ vault
const capLeft = (ctx: Ctx, pid: number) => vaultCapacity(ctx.db, pid) - vaultUsed(ctx.db, pid);

export function vaultMove(ctx: Ctx, pid: number, dir: 'deposit' | 'withdraw', ref: string, n = 1): Result {
  const { db } = ctx;
  n = Math.max(1, Math.floor(n));
  return tx(db, () => {
    requireHome(loadPlayer(ctx, pid));
    const d = findItem(ref);
    const eqId = Number(String(ref).replace('#', ''));
    if (d ? isEquipment(d.id) : Number.isFinite(eqId) && eqId > 0) {
      const from = dir === 'deposit' ? 'bag' : 'vault', to = dir === 'deposit' ? 'vault' : 'bag';
      const row = (d
        ? db.prepare('SELECT * FROM player_equipment WHERE player_id = ? AND item_id = ? AND location = ? AND equipped = 0 ORDER BY durability DESC').get(pid, d.id, from)
        : db.prepare('SELECT * FROM player_equipment WHERE id = ? AND player_id = ? AND location = ?').get(eqId, pid, from)) as any;
      if (!row) return fail(`No such unequipped gear in your ${from}.`);
      if (dir === 'deposit' && capLeft(ctx, pid) < 1) return fail('Your vault is full. Upgrade it with `/shelter upgrade vault`.');
      db.prepare('UPDATE player_equipment SET location = ?, equipped = 0 WHERE id = ?').run(to, row.id);
      return result('Vault', [`${dir === 'deposit' ? '🔒 Stored' : '🎒 Took out'} ${label(row.item_id)}.`]);
    }
    if (!d) return fail(`Unknown item "${ref}".`);
    if (dir === 'deposit') {
      if (capLeft(ctx, pid) < n) return fail(`Vault capacity left: ${capLeft(ctx, pid)}. Upgrade it with \`/shelter upgrade vault\`.`);
      takeItem(db, pid, d.id, n);
      db.prepare('INSERT INTO vault_contents (player_id,item_id,quantity) VALUES (?,?,?) ON CONFLICT(player_id,item_id) DO UPDATE SET quantity = quantity + excluded.quantity').run(pid, d.id, n);
    } else {
      const r = db.prepare('UPDATE vault_contents SET quantity = quantity - ? WHERE player_id = ? AND item_id = ? AND quantity >= ?').run(n, pid, d.id, n);
      if (!r.changes) return fail(`You don't have ${label(d.id, n)} in the vault.`);
      db.prepare('DELETE FROM vault_contents WHERE player_id = ? AND item_id = ? AND quantity = 0').run(pid, d.id);
      addItem(db, pid, d.id, n);
    }
    return result('Vault', [`${dir === 'deposit' ? '🔒 Stored' : '🎒 Took out'} ${label(d.id, n)}. Vault ${vaultUsed(db, pid)}/${vaultCapacity(db, pid)}.`]);
  });
}

// ------------------------------------------------------------------ world
export function cities(ctx: Ctx, pid: number, region?: string): Result {
  const p = loadPlayer(ctx, pid);
  const here = CITY_BY_ID[p.city_id];
  const list = CITIES.filter((c) => !region || c.region === region.toLowerCase());
  if (!list.length) return fail(`Unknown region. Regions: ${REGIONS.join(', ')}`);
  const lines: string[] = [];
  for (const r of REGIONS) {
    const cs = list.filter((c) => c.region === r);
    if (!cs.length) continue;
    lines.push(`**${r.toUpperCase()}**`);
    for (const c of cs) lines.push(`${c.id === p.city_id ? '📍' : '▫️'} ${c.name} — ${'⚠️'.repeat(c.danger)} ${c.archetype}${c.radiation >= 0.3 ? ' ☢️' : ''} · travel ${travelCost(here, c)}⚡`);
  }
  return result('Cities', lines, { cities: list.map((c) => ({ ...c, travel: travelCost(here, c) })), current: p.city_id });
}

export function travel(ctx: Ctx, pid: number, cityQ: string): Result {
  const dest = findCity(cityQ);
  if (!dest) return fail(`Unknown city "${cityQ}". See /cities.`);
  return tx(ctx.db, () => {
    const p = loadPlayer(ctx, pid);
    if (ctx.db.prepare("SELECT 1 FROM missions WHERE player_id = ? AND status = 'active'").get(pid)) return fail('Finish your mission first (`/mission report`).');
    if (p.city_id === dest.id) return fail('You are already here.');
    const cost = travelCost(CITY_BY_ID[p.city_id], dest);
    if (p.energy < cost) return fail(`Travel needs ${cost}⚡ energy (you have ${p.energy}).`);
    if (p.food < 3 || p.water < 3) return fail('You are too weak to travel — eat and drink first.');
    ctx.db.prepare('UPDATE players SET energy = energy - ?, food = food - 2, water = water - 3, city_id = ? WHERE id = ?').run(cost, dest.id, pid);
    return result(`Arrived in ${dest.name}`, [
      `You travel to **${dest.name}** (${dest.region}). -${cost}⚡ -2🍖 -3💧`,
      `Danger ${'⚠️'.repeat(dest.danger)} · ${dest.archetype}${dest.radiation >= 0.3 ? ' · ☢️ radiation' : ''} · storms ×${dest.stormFactor}`,
    ]);
  });
}

/** Scavengers whose shelter is in the player's current city (= valid raid targets) plus who else is here. */
export function nearby(ctx: Ctx, pid: number): Result {
  const { db } = ctx;
  const me = loadPlayer(ctx, pid);
  const now = ctx.now();
  const rows = db.prepare(`SELECT p.id, p.name, p.level, p.karma, p.protected_until, p.raid_shield_until, p.home_city_id, p.city_id,
      (SELECT c.tag FROM crew_members m JOIN crews c ON c.id = m.crew_id WHERE m.player_id = p.id) AS crew_tag,
      (SELECT created_at FROM attack_log a WHERE a.kind = 'raid' AND a.attacker_id = ? AND a.defender_id = p.id ORDER BY a.id DESC LIMIT 1) AS last_raid
    FROM players p WHERE p.id <> ? AND (p.home_city_id = ? OR p.city_id = ?) ORDER BY p.level DESC, p.name LIMIT 40`).all(pid, pid, me.city_id, me.city_id) as any[];
  const cd = economy(db).raid_cooldown_minutes * MIN;
  const list = rows.map((r) => {
    const home = r.home_city_id === me.city_id;
    const reason = !home ? 'shelter is elsewhere' : r.protected_until > now ? `new-player protection ${Math.ceil((r.protected_until - now) / MIN)}m`
      : r.raid_shield_until > now ? `raid shield ${Math.ceil((r.raid_shield_until - now) / MIN)}m`
      : r.last_raid && now - r.last_raid < cd ? `cooldown ${Math.ceil((cd - (now - r.last_raid)) / MIN)}m` : null;
    return { name: r.name, level: r.level, crew: r.crew_tag, criminal: isCriminal(r), home, present: r.city_id === me.city_id, raidable: home && !reason, reason };
  });
  const lines = list.length ? list.map((x) => `${x.raidable ? '⚔️' : '🛡️'} **${x.name}** L${x.level}${x.crew ? ` [${x.crew}]` : ''}${x.criminal ? ' 🏴' : ''} — ${x.home ? 'shelter here' : 'visiting'}${x.present ? ', in town' : ''}${x.reason ? ` · ${x.reason}` : ' · **can be raided**'}`)
    : ['Nobody else is around. Travel to another city, or invite a friend to /register.'];
  lines.push('', `You are in **${CITY_BY_ID[me.city_id].name}**. Raid with \`/attack player\` (costs ${economy(db).raid_energy_cost}⚡). Vaults are raid-proof.`);
  return result('Scavengers nearby', lines, { players: list, city: me.city_id });
}
