import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from '../src/db/index.js';
import type { Ctx } from '../src/game/ctx.js';
import { run } from '../src/game/actions.js';
import { vcApply, addItem, qty, loadPlayer } from '../src/game/store.js';
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
  const reg = (name: string, discordId?: string, city = 'cinder_gate') => {
    const r = run(ctx, 'player/register', null, { name, discordId, city });
    return (r.data as any).playerId as number;
  };
  return { db, ctx, advance, reg };
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

test('crafting: stove cooks, furnace needs power, structure limits', () => {
  const { ctx, db, reg } = setup();
  const pid = reg('Fay');
  addItem(db, pid, 'scrap', 100); addItem(db, pid, 'wood', 50);
  run(ctx, 'craft/make', pid, { recipe: 'stove' });
  run(ctx, 'craft/make', pid, { recipe: 'furnace' });
  addItem(db, pid, 'raw_meat', 2);
  run(ctx, 'craft/make', pid, { recipe: 'cook_meat', qty: 2 });
  assert.equal(qty(db, pid, 'cooked_meat'), 2);
  assert.throws(() => run(ctx, 'craft/make', pid, { recipe: 'smelt_iron' }), /power/);
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
