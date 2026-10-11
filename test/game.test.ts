import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from '../src/db/index.js';
import type { Ctx } from '../src/game/ctx.js';
import { run } from '../src/game/actions.js';
import { vcApply, addItem, addEquipment, qty, loadPlayer } from '../src/game/store.js';
import { tick } from '../src/game/world.js';
import { resolve } from '../src/game/missions.js';
import { MIN } from '../src/data/progression.js';
import { CITIES } from '../src/data/world.js';

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  let t = Date.UTC(2999, 0, 1, 12, 0, 0) - 2999 * 0; // fixed clock
  const ctx: Ctx = { db, now: () => t };
  const advance = (ms: number) => { t += ms; };
  /** brand-new scavenger exactly as the game creates them (no shelter, no items) */
  const regFresh = (name: string, discordId?: string, city = 'cinder_gate') => {
    const r = run(ctx, 'player/register', null, { name, discordId, city });
    return (r.data as any).playerId as number;
  };
  /** a "settled" scavenger for tests of mid-game systems: built shelter, workbench, a bat and some materials */
  const reg = (name: string, discordId?: string, city = 'cinder_gate') => {
    const id = regFresh(name, discordId, city);
    db.prepare('UPDATE shelters SET built = 1, hp = max_hp, door_hp = 60 WHERE player_id = ?').run(id);
    db.prepare("INSERT INTO shelter_structures (player_id,structure,level,quantity) VALUES (?,'workbench',1,1)").run(id);
    for (const [i, n] of Object.entries({ scrap: 15, wood: 6, cloth: 4, canned_food: 2, clean_water: 2 })) addItem(db, id, i, n);
    addEquipment(ctx, id, 'bat');
    return id;
  };
  return { db, ctx, advance, reg, regFresh };
}

test('schema: 50 cities, singleton tables enforce id = 1', () => {
  const { db } = setup();
  assert.equal(CITIES.length, 50);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM cities').get() as any).n, 50);
  assert.throws(() => db.prepare('INSERT INTO economy_stats (id) VALUES (2)').run());
  assert.throws(() => db.prepare('INSERT INTO world_state (id) VALUES (2)').run());
});

test('register + status, duplicate name rejected', () => {
  const { ctx, reg } = setup();
  const pid = reg('Alice', 'd1');
  const s = run(ctx, 'player/status', pid);
  assert.match(s.title, /Alice/);
  assert.throws(() => reg('alice', 'd2'), /taken/);
  assert.throws(() => reg('Alice2', 'd1'), /already registered/);
});

test('Void Coin ledger is idempotent and cannot overdraw', () => {
  const { ctx, reg } = setup();
  const pid = reg('Bob');
  assert.equal(vcApply(ctx, pid, 10, 'test', 'k1'), true);
  assert.equal(vcApply(ctx, pid, 10, 'test', 'k1'), false); // replay is a no-op
  assert.equal(loadPlayer(ctx, pid).void_coins, 10);
  assert.throws(() => vcApply(ctx, pid, -11, 'test', 'k2'), /Not enough Void Coins/);
  assert.equal(loadPlayer(ctx, pid).void_coins, 10);
});

test('mission: timed, resolves exactly once, loot credited once', () => {
  const { ctx, db, reg, advance } = setup();
  const pid = reg('Carol');
  run(ctx, 'mission/start', pid, { length: 'quick' });
  assert.throws(() => run(ctx, 'mission/start', pid, {}), /already on a mission/);
  const early = run(ctx, 'mission/report', pid);
  assert.match(early.title, /in progress/);
  advance(6 * MIN);
  const mid = (db.prepare('SELECT id FROM missions WHERE player_id = ?').get(pid) as any).id;
  const scrapBefore = qty(db, pid, 'scrap');
  const a = resolve(ctx, mid);
  const scrapAfter = qty(db, pid, 'scrap');
  const b = resolve(ctx, mid); // second resolve must not pay again
  assert.equal(qty(db, pid, 'scrap'), scrapAfter);
  assert.equal(a.id, b.id);
  assert.ok(scrapAfter >= scrapBefore);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM mission_log WHERE mission_id = ?').get(mid) as any).n, 1);
  const rep = run(ctx, 'mission/report', pid);
  assert.match(rep.title, /Mission report/);
});

test('food/water shortage penalises loot', () => {
  const { ctx, db, reg } = setup();
  const pid = reg('Dan');
  db.prepare('UPDATE players SET food = 0, water = 0 WHERE id = ?').run(pid);
  db.prepare("DELETE FROM player_inventory WHERE item_id IN ('canned_food','clean_water')").run();
  run(ctx, 'mission/start', pid, { length: 'quick' });
  const m = db.prepare('SELECT pen_food, pen_water FROM missions WHERE player_id = ?').get(pid) as any;
  assert.equal(m.pen_food, 1);
  assert.equal(m.pen_water, 1);
});

test('storm applies once per slot even if tick runs repeatedly', () => {
  const { ctx, db, reg, advance } = setup();
  const pid = reg('Eve');
  db.prepare('UPDATE players SET created_at = 0 WHERE id = ?').run(pid);
  const hp = () => (db.prepare('SELECT hp FROM shelters WHERE player_id = ?').get(pid) as any).hp;
  const storms = () => (db.prepare("SELECT COUNT(*) n FROM shelter_event_log WHERE player_id = ? AND kind = 'storm'").get(pid) as any).n;
  const hp0 = hp();
  advance(4 * 60 * MIN + 1); // next storm slot
  db.prepare('UPDATE players SET last_seen_at = ? WHERE id = ?').run(ctx.now(), pid);
  tick(ctx, true);
  const hp1 = hp();
  assert.ok(hp1 < hp0);
  assert.equal(storms(), 1);
  tick(ctx, true); tick(ctx, true);
  assert.equal(hp(), hp1); // replays do nothing
  // simulate a racing second process: cursor rewound, but UNIQUE(player_id,event_key) blocks double damage
  db.prepare("UPDATE watcher_cursors SET cursor = cursor - 1 WHERE name = 'storm'").run();
  tick(ctx, true);
  assert.equal(storms(), 1);
  assert.equal(hp(), hp1);
  advance(4 * 60 * MIN);
  tick(ctx, true);
  assert.equal(storms(), 2);
  assert.throws(() => db.prepare("INSERT INTO world_events (event_key,kind,slot,created_at) SELECT event_key,kind,slot,created_at FROM world_events LIMIT 1").run(), /UNIQUE/);
});

test('crafting: stove cooks, furnace burns wood, structure limits', () => {
  const { ctx, db, reg } = setup();
  const pid = reg('Fay');
  addItem(db, pid, 'scrap', 100); addItem(db, pid, 'wood', 50); addItem(db, pid, 'stone', 60);
  run(ctx, 'craft/make', pid, { recipe: 'stove' });
  run(ctx, 'craft/make', pid, { recipe: 'furnace' });
  addItem(db, pid, 'raw_meat', 2);
  run(ctx, 'craft/make', pid, { recipe: 'cook_meat', qty: 2 });
  assert.equal(qty(db, pid, 'cooked_meat'), 2);
  run(ctx, 'craft/make', pid, { recipe: 'smelt_scrap' }); // furnaces burn wood — no electricity needed
  assert.equal(qty(db, pid, 'iron_ingot'), 1);
  assert.throws(() => run(ctx, 'craft/make', pid, { recipe: 'forge_steel' }), /Missing/); // steel needs coal + iron
  assert.throws(() => run(ctx, 'craft/make', pid, { recipe: 'stove' }), /maximum/);
  const eat = run(ctx, 'player/use', pid, { item: 'cooked_meat', qty: 1 });
  assert.match(eat.lines[0], /food/);
});

test('farming: needs seeds + clean water; thirsty crop delays harvest', () => {
  const { ctx, db, reg, advance } = setup();
  const pid = reg('Gus');
  addItem(db, pid, 'scrap', 20); addItem(db, pid, 'wood', 20); addItem(db, pid, 'cloth', 10);
  addItem(db, pid, 'seed_potato', 1); addItem(db, pid, 'clean_water', 5);
  assert.throws(() => run(ctx, 'planter/plant', pid, { slot: 1, seed: 'seed_potato' }), /Planter slot/);
  run(ctx, 'craft/make', pid, { recipe: 'planter' });
  run(ctx, 'planter/plant', pid, { slot: 1, seed: 'seed_potato' });
  advance(25 * MIN);
  assert.throws(() => run(ctx, 'planter/harvest', pid, {}), /Nothing is ready/); // thirsty => stalled
  const w = run(ctx, 'planter/water', pid, { slot: 1 });
  assert.match(w.lines[0], /delayed/);
  advance(5 * MIN);
  assert.throws(() => run(ctx, 'planter/harvest', pid, {}), /Nothing is ready/);
  advance(10 * MIN + 1);
  const h = run(ctx, 'planter/harvest', pid, {});
  assert.match(h.lines[0], /Potato/);
});

test('raid: protected newbies are safe; broken door lets attacker loot only non-vault items', () => {
  const { ctx, db, reg, advance } = setup();
  const att = reg('Raider', 'a'), def = reg('Victim', 'b');
  assert.throws(() => run(ctx, 'attack/player', att, { name: 'Victim' }), /protection/);
  advance(200 * MIN);
  addItem(db, def, 'scrap', 100);
  run(ctx, 'vault/deposit', def, { item: 'scrap', qty: 30 });
  db.prepare('UPDATE shelters SET door_hp = 1 WHERE player_id = ?').run(def);
  const vc = loadPlayer(ctx, def).void_coins;
  const r = run(ctx, 'attack/player', att, { name: 'Victim' });
  assert.equal((r.data as any).outcome, 'success');
  assert.equal((db.prepare('SELECT quantity q FROM vault_contents WHERE player_id = ? AND item_id = ?').get(def, 'scrap') as any).q, 30);
  assert.equal(loadPlayer(ctx, def).void_coins, vc);
  assert.ok(qty(db, att, 'scrap') > 15);
  assert.throws(() => run(ctx, 'attack/player', att, { name: 'Victim' }), /shield|Cooldown/);
  assert.ok((db.prepare('SELECT COUNT(*) n FROM notifications WHERE player_id = ?').get(def) as any).n >= 1);
});

test('merchant: visits are deterministic, offers labelled, each deal only once', () => {
  const { ctx, db, reg } = setup();
  const pid = reg('Hal');
  // find a city+slot with a merchant by scanning cities
  let found = false;
  for (const c of CITIES) {
    db.prepare('UPDATE players SET city_id = ? WHERE id = ?').run(c.id, pid);
    const v = run(ctx, 'merchant/view', pid);
    if ((v.data as any).visits.length) { found = true; break; }
  }
  assert.ok(found, 'some city should have the merchant in this slot');
  const again = run(ctx, 'merchant/view', pid);
  const offers = (again.data as any).visits[0].offers as any[];
  assert.equal(offers.length, 4);
  assert.ok(offers.every((o) => ['good', 'fair', 'poor', 'scam'].includes(o.fairness)));
  const visitsBefore = (db.prepare('SELECT COUNT(*) n FROM merchant_visits').get() as any).n;
  run(ctx, 'merchant/view', pid);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM merchant_visits').get() as any).n, visitsBefore);
  // give the player everything so any offer is payable, then trade it twice
  for (const i of ['scrap', 'wood', 'cloth', 'wire', 'rope', 'iron_ingot', 'battery', 'monster_hide', 'bone', 'canned_food', 'clean_water', 'cooked_meat', 'potato', 'tomato']) addItem(db, pid, i, 100);
  vcApply(ctx, pid, 500, 'test', 'seed-vc');
  const offer = offers[0];
  run(ctx, 'merchant/trade', pid, { offer: offer.id });
  assert.throws(() => run(ctx, 'merchant/trade', pid, { offer: offer.id }), /already took/);
});

test('crew: invite/join, expand costs Void Coins, size capped at 10', () => {
  const { ctx, db, reg } = setup();
  const boss = reg('Boss'), m1 = reg('Mate1');
  run(ctx, 'crew/create', boss, { name: 'Night Owls', tag: 'OWL' });
  assert.throws(() => run(ctx, 'crew/join', m1, { name: 'Night Owls' }), /invite/);
  run(ctx, 'crew/invite', boss, { name: 'Mate1' });
  run(ctx, 'crew/join', m1, { name: 'Night Owls' });
  assert.throws(() => run(ctx, 'crew/expand', boss, {}), /Not enough Void Coins/);
  vcApply(ctx, boss, 1000, 'test', 'grant');
  for (let i = 0; i < 5; i++) run(ctx, 'crew/expand', boss, {});
  assert.throws(() => run(ctx, 'crew/expand', boss, {}), /maximum/);
  assert.equal((db.prepare('SELECT max_members m FROM crews').get() as any).m, 10);
  // 40+60+80+100+120 = 400 burned
  assert.equal(loadPlayer(ctx, boss).void_coins, 600);
  const info = run(ctx, 'crew/info', m1, {});
  assert.match(info.lines.join('\n'), /Boss/);
});

test('travel, vault limits, robot craft', () => {
  const { ctx, db, reg } = setup();
  const pid = reg('Ivy');
  run(ctx, 'world/travel', pid, { city: 'Kiln Town' });
  assert.throws(() => run(ctx, 'vault/deposit', pid, { item: 'scrap', qty: 1 }), /Travel home/);
  run(ctx, 'world/travel', pid, { city: 'cinder_gate' });
  addItem(db, pid, 'scrap', 100);
  assert.throws(() => run(ctx, 'vault/deposit', pid, { item: 'scrap', qty: 31 }), /capacity/);
  run(ctx, 'vault/deposit', pid, { item: 'scrap', qty: 30 });
  for (const [i, n] of Object.entries({ circuit: 4, battery: 3, iron_ingot: 6, wire: 6 })) addItem(db, pid, i, n);
  run(ctx, 'craft/make', pid, { recipe: 'scav_bot' });
  assert.match(run(ctx, 'robot/mode', pid, { mode: 'home' }).lines[0], /guards/);
});

test('players list shows raid targets in the current city', () => {
  const { ctx, db, reg, advance } = setup();
  const a = reg('Seeker'), b = reg('Target');
  let r = run(ctx, 'world/players', a);
  assert.equal((r.data as any).players[0].raidable, false); // newbie protection
  advance(200 * MIN);
  db.prepare('UPDATE players SET city_id = ? WHERE id = ?').run('cinder_gate', a);
  r = run(ctx, 'world/players', a);
  assert.equal((r.data as any).players[0].raidable, true);
  void b;
});

// ------------------------------------------------------------------ crew vault & crew raids
function crewSetup(prefix: string, n: number, s = setup(), city = 'cinder_gate') {
  const { ctx, db, reg } = s;
  const ids = Array.from({ length: n }, (_, i) => reg(`${prefix}${i}`, undefined, city));
  db.prepare(`UPDATE players SET home_city_id = ?, city_id = ?, created_at = 0, protected_until = 0 WHERE id IN (${ids.join(',')})`).run(city, city);
  run(ctx, 'crew/create', ids[0], { name: `${prefix} Crew`, tag: prefix.toUpperCase().slice(0, 3) });
  for (const id of ids.slice(1)) { run(ctx, 'crew/invite', ids[0], { playerId: id }); run(ctx, 'crew/join', id, { name: `${prefix} Crew` }); }
  db.prepare('UPDATE crews SET created_at = 0 WHERE name = ?').run(`${prefix} Crew`);
  return { ...s, ids };
}

test('crew vault: anyone deposits, only leader/trusted take out, leader rewards anyone incl. self', () => {
  const s = crewSetup('Vlt', 3);
  const { ctx, db, ids } = s;
  const [boss, a, b] = ids;
  addItem(db, a, 'scrap', 10); addItem(db, boss, 'wood', 5);
  run(ctx, 'crew/deposit', a, { item: 'scrap', qty: 10 });
  run(ctx, 'crew/deposit', boss, { item: 'wood', qty: 5 });
  assert.equal(qty(db, a, 'scrap'), 15); // started with 15, deposited 10 of the 10 added => 15 left
  assert.match(run(ctx, 'crew/vault', a, {}).title, /🔒/);                       // member sees only capacity
  assert.throws(() => run(ctx, 'crew/reward', a, { item: 'scrap', qty: 1 }), /leader/);
  assert.match(run(ctx, 'crew/vault', boss, {}).lines.join('\n'), /Scrap/);
  run(ctx, 'crew/reward', boss, { item: 'scrap', qty: 4, playerId: b });         // to a member
  run(ctx, 'crew/reward', boss, { item: 'wood', qty: 2 });                        // to himself
  assert.equal(qty(db, b, 'scrap'), 15 + 4);
  assert.equal(qty(db, boss, 'wood'), 6 + 2);
  assert.throws(() => run(ctx, 'crew/perms', a, { playerId: b, vault: true }), /leader/);
  run(ctx, 'crew/perms', boss, { playerId: a, vault: true });
  run(ctx, 'crew/reward', a, { item: 'scrap', qty: 1, playerId: a });            // trusted member can now
  assert.equal((db.prepare("SELECT COUNT(*) n FROM crew_vault_log WHERE kind = 'reward'").get() as any).n, 3);
  const outsider = s.reg('Outsider');
  assert.throws(() => run(ctx, 'crew/reward', boss, { item: 'wood', qty: 1, playerId: outsider }), /own crew/);
});

test('crew raid on a building: costs energy/food/water, loot goes to crew vault, launches once', () => {
  const s = crewSetup('Bld', 3);
  const { ctx, db, ids } = s;
  const [boss, a, b] = ids;
  assert.throws(() => run(ctx, 'crewraid/start', a, { kind: 'building' }), /leader/);
  const before = db.prepare('SELECT energy, food, water FROM players WHERE id = ?').get(a) as any;
  run(ctx, 'crewraid/start', boss, { kind: 'building' });
  assert.throws(() => run(ctx, 'crewraid/start', boss, { kind: 'building' }), /already/);
  assert.throws(() => run(ctx, 'crewraid/launch', boss, {}), /at least 2/);
  run(ctx, 'crewraid/join', a, {});
  assert.throws(() => run(ctx, 'world/travel', a, { city: 'ember_hollow' }), /crew raid/);
  assert.throws(() => run(ctx, 'mission/start', a, {}), /crew raid/);
  run(ctx, 'crewraid/join', b, {});
  const after = db.prepare('SELECT energy, food, water FROM players WHERE id = ?').get(a) as any;
  assert.ok(after.energy < before.energy && after.food < before.food && after.water < before.water);
  const r = run(ctx, 'crewraid/launch', boss, {});
  assert.match(r.title, /Crew raid/);
  assert.throws(() => run(ctx, 'crewraid/launch', boss, {}), /no raid lobby/);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM crew_raid_log').get() as any).n, 1);
  if ((r.data as any).victory) {
    const loot = (r.data as any).loot as Record<string, number>;
    const inVault = (db.prepare('SELECT COALESCE(SUM(quantity),0) n FROM crew_vault').get() as any).n;
    assert.ok(Object.keys(loot).length > 3 && inVault > 10, 'building loot should be rich');
  }
  run(ctx, 'world/travel', a, { city: 'ember_hollow' }); // free again after launch
});

test('crew raid lobby: leaving/cancelling refunds exactly, expiry cancels', () => {
  const s = crewSetup('Rfd', 3);
  const { ctx, db, ids, advance } = s;
  const [boss, a] = ids;
  const bars = (id: number) => db.prepare('SELECT energy, food, water FROM players WHERE id = ?').get(id) as any;
  const b0 = bars(boss), a0 = bars(a);
  run(ctx, 'crewraid/start', boss, { kind: 'monster' });
  run(ctx, 'crewraid/join', a, {});
  run(ctx, 'crewraid/leave', a, {});
  assert.deepEqual(bars(a), a0);
  run(ctx, 'crewraid/join', a, {});
  advance(16 * MIN);
  tick(ctx, true);
  assert.equal((db.prepare('SELECT status FROM crew_raids').get() as any).status, 'cancelled');
  assert.deepEqual(bars(boss), b0);
  assert.deepEqual(bars(a), a0);
  run(ctx, 'mission/start', a, { length: 'quick' }); // unblocked
});

test('crew vs crew raid steals from the rival crew vault, shields them, blocks repeats', () => {
  const s = setup();
  const att = crewSetup('Att', 3, s), def = crewSetup('Def', 2, s);
  const { ctx, db } = s;
  addItem(db, def.ids[1], 'iron_ingot', 50);
  run(ctx, 'crew/deposit', def.ids[1], { item: 'iron_ingot', qty: 50 });
  // make attackers clearly stronger so the outcome is not a coin flip
  for (const id of att.ids) { db.prepare('UPDATE players SET level = 20 WHERE id = ?').run(id); addItem(db, id, 'bullets', 60); db.prepare("INSERT INTO player_equipment (player_id,item_id,durability,max_durability,equipped,location,created_at) VALUES (?,'rifle',80,80,1,'bag',0)").run(id); }
  db.prepare('UPDATE players SET hp = 10 WHERE id = ?').run(def.ids[1]); // defender too hurt to defend; owner is alone
  assert.throws(() => run(ctx, 'crewraid/start', att.ids[0], { kind: 'crew', target: 'Nonexistent' }), /rival crew/);
  run(ctx, 'crewraid/start', att.ids[0], { kind: 'crew', target: 'Def Crew' });
  run(ctx, 'crewraid/join', att.ids[1], {}); run(ctx, 'crewraid/join', att.ids[2], {});
  const r = run(ctx, 'crewraid/launch', att.ids[0], {});
  assert.equal((r.data as any).victory, true);
  assert.ok((db.prepare("SELECT quantity q FROM crew_vault v JOIN crews c ON c.id = v.crew_id WHERE c.name = 'Def Crew'").get() as any).q < 50);
  assert.ok((db.prepare("SELECT quantity q FROM crew_vault v JOIN crews c ON c.id = v.crew_id WHERE c.name = 'Att Crew' AND item_id = 'iron_ingot'").get() as any).q > 0);
  assert.throws(() => run(ctx, 'crewraid/start', att.ids[0], { kind: 'crew', target: 'Def Crew' }), /shielded|cooldown/);
  assert.ok((db.prepare('SELECT COUNT(*) n FROM notifications WHERE player_id = ?').get(def.ids[0]) as any).n >= 1);
});


// ---------------------------------------------------------------- fresh start / gathering / tiers
test('new scavenger: full bars, nothing owned, no shelter; must pick a starter town', () => {
  const { ctx, db, regFresh } = setup();
  assert.throws(() => run(ctx, 'player/register', null, { name: 'Brave', city: 'void_s_edge' }), /starter towns/);
  assert.throws(() => run(ctx, 'player/register', null, { name: 'Brave', city: 'kiln_town' }), /starter towns/);
  const pid = regFresh('Newbie', undefined, 'pale_orchard');
  const p = loadPlayer(ctx, pid);
  assert.deepEqual([p.hp, p.energy, p.food, p.water], [100, 100, 100, 100]);
  assert.equal(p.city_id, 'pale_orchard');
  assert.equal((db.prepare('SELECT COUNT(*) n FROM player_inventory WHERE player_id = ?').get(pid) as any).n, 0);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM player_equipment WHERE player_id = ?').get(pid) as any).n, 0);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM shelter_structures WHERE player_id = ?').get(pid) as any).n, 0);
  assert.equal((db.prepare('SELECT built FROM shelters WHERE player_id = ?').get(pid) as any).built, 0);
  assert.match(run(ctx, 'shelter/view', pid).title, /No shelter/);
  assert.match(run(ctx, 'player/status', pid).lines.join('\n'), /No shelter yet/);
  assert.throws(() => run(ctx, 'shelter/build', pid), /Missing/);
  assert.throws(() => run(ctx, 'craft/make', pid, { recipe: 'workbench' }), /shelter/);
  assert.throws(() => run(ctx, 'vault/deposit', pid, { item: 'scrap', qty: 1 }), /shelter/);
  assert.throws(() => run(ctx, 'gather/do', pid, { target: 'chop' }), /need an axe/);
});

test('first session: gather by hand -> stone tools -> wood/stone/cloth -> build shelter -> workbench', () => {
  const { ctx, db, regFresh } = setup();
  const pid = regFresh('Pioneer');
  const top = () => db.prepare('UPDATE players SET energy = 100, food = 100, water = 100 WHERE id = ?').run(pid);
  while (qty(db, pid, 'branch') < 4) { top(); run(ctx, 'gather/do', pid, { target: 'branches' }); }
  while (qty(db, pid, 'small_stone') < 6) { top(); run(ctx, 'gather/do', pid, { target: 'stones' }); }
  run(ctx, 'craft/make', pid, { recipe: 'stone_axe' });
  run(ctx, 'craft/make', pid, { recipe: 'stone_pickaxe' });
  while (qty(db, pid, 'wood') < 20) { top(); run(ctx, 'gather/do', pid, { target: 'chop' }); }
  while (qty(db, pid, 'stone') < 14) { top(); run(ctx, 'gather/do', pid, { target: 'mine' }); }
  while (qty(db, pid, 'cloth') < 6) { top(); run(ctx, 'gather/do', pid, { target: 'rags' }); }
  assert.equal(qty(db, pid, 'copper_ore'), 0); // stone pickaxe can't find ore
  const r = run(ctx, 'shelter/build', pid);
  assert.match(r.title, /built/);
  assert.throws(() => run(ctx, 'shelter/build', pid), /already/);
  assert.equal((db.prepare('SELECT built, hp FROM shelters WHERE player_id = ?').get(pid) as any).built, 1);
  addItem(db, pid, 'branch', 4); addItem(db, pid, 'wood', 8); addItem(db, pid, 'stone', 4);
  run(ctx, 'craft/make', pid, { recipe: 'workbench' });
  assert.equal((db.prepare("SELECT quantity q FROM shelter_structures WHERE player_id = ? AND structure = 'workbench'").get(pid) as any).q, 1);
});

test('stone tools break quickly; better tiers unlock ores', () => {
  const { ctx, db, regFresh } = setup();
  const pid = regFresh('Miner');
  const top = () => db.prepare('UPDATE players SET energy = 100, food = 100, water = 100 WHERE id = ?').run(pid);
  addItem(db, pid, 'branch', 2); addItem(db, pid, 'small_stone', 3);
  run(ctx, 'craft/make', pid, { recipe: 'stone_pickaxe' });
  for (let i = 0; i < 12; i++) { top(); run(ctx, 'gather/do', pid, { target: 'mine' }); }
  assert.throws(() => run(ctx, 'gather/do', pid, { target: 'mine' }), /need a pickaxe/); // broke after 12 uses
  assert.equal(qty(db, pid, 'copper_ore') + qty(db, pid, 'coal') + qty(db, pid, 'iron_ore'), 0);
  // iron pickaxe: coal and iron ore appear
  db.prepare("INSERT INTO player_equipment (player_id,item_id,durability,max_durability,equipped,location,created_at) VALUES (?,'iron_pickaxe',70,70,0,'bag',0)").run(pid);
  for (let i = 0; i < 20; i++) { top(); run(ctx, 'gather/do', pid, { target: 'mine' }); }
  assert.ok(qty(db, pid, 'iron_ore') + qty(db, pid, 'coal') + qty(db, pid, 'copper_ore') > 0);
  assert.equal(qty(db, pid, 'adamantite_ore'), 0); // needs a forged-steel pickaxe in a dangerous city
});

test('metal chain: ore -> copper -> iron -> forged steel -> adamantium', () => {
  const { ctx, db, reg } = setup();
  const pid = reg('Smith');
  for (const [i, n] of Object.entries({ stone: 40, scrap: 40, wood: 60, copper_ore: 8, iron_ore: 8, iron_ingot: 10, coal: 14, adamantite_ore: 3, rope: 10, cloth: 4 })) addItem(db, pid, i, n);
  run(ctx, 'craft/make', pid, { recipe: 'furnace' });
  run(ctx, 'craft/make', pid, { recipe: 'smelt_copper', qty: 4 });
  run(ctx, 'craft/make', pid, { recipe: 'smelt_iron', qty: 4 });
  assert.equal(qty(db, pid, 'copper_ingot'), 4);
  run(ctx, 'craft/make', pid, { recipe: 'scrap_axe' });
  run(ctx, 'craft/make', pid, { recipe: 'copper_pickaxe' });
  run(ctx, 'craft/make', pid, { recipe: 'iron_pickaxe' });
  run(ctx, 'craft/make', pid, { recipe: 'forge_steel', qty: 5 });
  assert.equal(qty(db, pid, 'steel_ingot'), 5);
  run(ctx, 'craft/make', pid, { recipe: 'steel_pickaxe' });
  run(ctx, 'craft/make', pid, { recipe: 'forge_adamantium' });
  assert.equal(qty(db, pid, 'adamantium_ingot'), 1);
  assert.throws(() => run(ctx, 'craft/make', pid, { recipe: 'adamantium_axe' }), /Missing/); // needs 4 ingots
});

test('missions run in SECONDS in test mode (5/15/30)', () => {
  const { ctx, db, regFresh, advance } = setup();
  const pid = regFresh('Quick');
  run(ctx, 'mission/start', pid, { length: 'quick' });
  const m = db.prepare('SELECT started_at, ends_at FROM missions WHERE player_id = ?').get(pid) as any;
  assert.equal(m.ends_at - m.started_at, 5_000);
  assert.match(run(ctx, 'mission/report', pid).title, /in progress/);
  advance(5_001);
  assert.match(run(ctx, 'mission/report', pid).title, /Mission report/);
  run(ctx, 'mission/start', pid, { length: 'deep' });
  const d = db.prepare("SELECT started_at, ends_at FROM missions WHERE status = 'active'").get() as any;
  assert.equal(d.ends_at - d.started_at, 30_000);
});

test('unbuilt shelters are not raided, stormed or attacked by monsters', () => {
  const { ctx, db, reg, regFresh, advance } = setup();
  const att = reg('Bully'), vic = regFresh('Homeless');
  advance(200 * MIN);
  assert.throws(() => run(ctx, 'attack/player', att, { name: 'Homeless' }), /not built a shelter/);
  db.prepare('UPDATE players SET created_at = 0, last_seen_at = ? WHERE id = ?').run(ctx.now(), vic);
  advance(5 * 60 * MIN);
  tick(ctx, true);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM shelter_event_log WHERE player_id = ?').get(vic) as any).n, 0);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM monster_attack_log WHERE player_id = ?').get(vic) as any).n, 0);
});
