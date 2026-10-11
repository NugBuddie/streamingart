/**
 * World content: archetypes (loot tables), monsters, bandits and the 50 cities.
 * Add a city = add one row to CITY_ROWS. Cities are upserted into the `cities` table on startup.
 */
export interface LootEntry {
  item: string;
  w: number;
  min: number;
  max: number;
  /** mechanical salvage: boosted by the Ratchet */
  salvage?: boolean;
}

const COMMON: LootEntry[] = [
  { item: 'scrap', w: 40, min: 2, max: 6, salvage: true },
  { item: 'wood', w: 14, min: 1, max: 4 },
  { item: 'cloth', w: 14, min: 1, max: 3 },
  { item: 'wire', w: 9, min: 1, max: 3, salvage: true },
  { item: 'dirty_water', w: 14, min: 1, max: 3 },
  { item: 'canned_food', w: 7, min: 1, max: 2 },
  { item: 'pebbles', w: 6, min: 4, max: 12 },
  { item: 'stone', w: 9, min: 1, max: 3 },
  { item: 'branch', w: 8, min: 1, max: 4 },
  { item: 'battery', w: 4, min: 1, max: 1, salvage: true },
  { item: 'seed_potato', w: 2, min: 1, max: 2 },
  { item: 'seed_carrot', w: 2, min: 1, max: 2 },
];

export type Archetype =
  | 'downtown' | 'industrial' | 'suburb' | 'farmland' | 'military'
  | 'harbor' | 'medical' | 'wasteland' | 'junkyard' | 'mall';

/** Extra weighted entries layered over COMMON. */
export const ARCHETYPES: Record<Archetype, { label: string; loot: LootEntry[]; monsters: string[] }> = {
  downtown: { label: 'Collapsed downtown', monsters: ['shade_rat', 'gutter_crawler', 'night_wraith'], loot: [
    { item: 'circuit', w: 10, min: 1, max: 2, salvage: true }, { item: 'wire', w: 14, min: 2, max: 4, salvage: true },
    { item: 'coffee_beans', w: 6, min: 1, max: 2 }, { item: 'canned_food', w: 8, min: 1, max: 3 } ] },
  industrial: { label: 'Dead factory belt', monsters: ['gutter_crawler', 'rust_ghoul', 'iron_behemoth'], loot: [
    { item: 'scrap', w: 40, min: 4, max: 9, salvage: true }, { item: 'iron_ingot', w: 8, min: 1, max: 2, salvage: true },
    { item: 'battery', w: 10, min: 1, max: 2, salvage: true }, { item: 'circuit', w: 5, min: 1, max: 1, salvage: true },
    { item: 'copper_ore', w: 8, min: 1, max: 3 }, { item: 'coal', w: 6, min: 1, max: 3 } ] },
  suburb: { label: 'Ghost suburb', monsters: ['shade_rat', 'ash_hound', 'gutter_crawler'], loot: [
    { item: 'cloth', w: 18, min: 2, max: 4 }, { item: 'wood', w: 16, min: 2, max: 5 },
    { item: 'canned_food', w: 10, min: 1, max: 3 }, { item: 'seed_tomato', w: 3, min: 1, max: 2 }, { item: 'tea_leaves', w: 5, min: 1, max: 2 } ] },
  farmland: { label: 'Overgrown farmland', monsters: ['ash_hound', 'shade_rat', 'bone_stalker'], loot: [
    { item: 'seed_cabbage', w: 6, min: 1, max: 2 }, { item: 'seed_corn', w: 4, min: 1, max: 2 }, { item: 'seed_pepper', w: 3, min: 1, max: 2 },
    { item: 'seed_berries', w: 2, min: 1, max: 1 }, { item: 'hops', w: 8, min: 1, max: 3 }, { item: 'potato', w: 10, min: 1, max: 4 },
    { item: 'corn', w: 6, min: 1, max: 3 }, { item: 'clean_water', w: 6, min: 1, max: 2 } ] },
  military: { label: 'Abandoned garrison', monsters: ['rust_ghoul', 'bone_stalker', 'iron_behemoth'], loot: [
    { item: 'gunpowder', w: 14, min: 1, max: 3 }, { item: 'bullets', w: 8, min: 2, max: 6 }, { item: 'iron_ingot', w: 8, min: 1, max: 2, salvage: true },
    { item: 'circuit', w: 6, min: 1, max: 1, salvage: true }, { item: 'medkit', w: 2, min: 1, max: 1 } ] },
  harbor: { label: 'Rotting harbor', monsters: ['gutter_crawler', 'night_wraith', 'bone_stalker'], loot: [
    { item: 'rope', w: 14, min: 1, max: 3 }, { item: 'dirty_water', w: 22, min: 2, max: 5 }, { item: 'clean_water', w: 5, min: 1, max: 2 },
    { item: 'scrap', w: 30, min: 3, max: 7, salvage: true }, { item: 'hops', w: 4, min: 1, max: 2 } ] },
  medical: { label: 'Derelict hospital', monsters: ['night_wraith', 'rust_ghoul', 'shade_rat'], loot: [
    { item: 'bandage', w: 14, min: 1, max: 3 }, { item: 'medkit', w: 4, min: 1, max: 1 }, { item: 'clean_water', w: 10, min: 1, max: 3 },
    { item: 'circuit', w: 6, min: 1, max: 1, salvage: true }, { item: 'cloth', w: 12, min: 2, max: 4 } ] },
  wasteland: { label: 'Irradiated wasteland', monsters: ['ash_hound', 'rust_ghoul', 'bone_stalker', 'night_wraith'], loot: [
    { item: 'dirty_water', w: 24, min: 2, max: 5 }, { item: 'bone', w: 14, min: 1, max: 3 }, { item: 'monster_hide', w: 6, min: 1, max: 2 },
    { item: 'battery', w: 7, min: 1, max: 2, salvage: true }, { item: 'seed_berries', w: 2, min: 1, max: 1 } ] },
  junkyard: { label: 'Wrecked-car junkyard', monsters: ['gutter_crawler', 'rust_ghoul', 'ash_hound'], loot: [
    { item: 'scrap', w: 45, min: 4, max: 10, salvage: true }, { item: 'battery', w: 14, min: 1, max: 2, salvage: true },
    { item: 'wire', w: 16, min: 2, max: 4, salvage: true }, { item: 'circuit', w: 7, min: 1, max: 2, salvage: true }, { item: 'iron_ingot', w: 6, min: 1, max: 2, salvage: true } ] },
  mall: { label: 'Looted megamall', monsters: ['shade_rat', 'night_wraith', 'gutter_crawler'], loot: [
    { item: 'cloth', w: 18, min: 2, max: 5 }, { item: 'canned_food', w: 12, min: 1, max: 3 }, { item: 'coffee_beans', w: 8, min: 1, max: 3 },
    { item: 'tea_leaves', w: 8, min: 1, max: 3 }, { item: 'seed_tomato', w: 4, min: 1, max: 2 }, { item: 'rope', w: 6, min: 1, max: 2 } ] },
};

export function lootTable(archetype: Archetype): LootEntry[] {
  return [...COMMON, ...ARCHETYPES[archetype].loot];
}

// ---------------------------------------------------------------- monsters
export interface MonsterDef {
  id: string;
  name: string;
  emoji: string;
  minDanger: number;
  maxDanger: number;
  hp: number;
  dmg: [number, number];
  loot: { item: string; chance: number; min: number; max: number }[];
}
export const MONSTERS: Record<string, MonsterDef> = Object.fromEntries(([
  { id: 'shade_rat', name: 'Shade Rat', emoji: '🐀', minDanger: 1, maxDanger: 2, hp: 26, dmg: [3, 7], loot: [{ item: 'raw_meat', chance: 0.8, min: 1, max: 2 }, { item: 'bone', chance: 0.3, min: 1, max: 1 }] },
  { id: 'ash_hound', name: 'Ash Hound', emoji: '🐺', minDanger: 1, maxDanger: 3, hp: 40, dmg: [5, 10], loot: [{ item: 'raw_meat', chance: 0.9, min: 1, max: 3 }, { item: 'monster_hide', chance: 0.4, min: 1, max: 1 }] },
  { id: 'gutter_crawler', name: 'Gutter Crawler', emoji: '🪲', minDanger: 2, maxDanger: 4, hp: 60, dmg: [7, 13], loot: [{ item: 'raw_meat', chance: 0.7, min: 2, max: 3 }, { item: 'scrap', chance: 0.6, min: 2, max: 5 }] },
  { id: 'rust_ghoul', name: 'Rust Ghoul', emoji: '🧟', minDanger: 3, maxDanger: 5, hp: 90, dmg: [10, 18], loot: [{ item: 'raw_meat', chance: 0.6, min: 2, max: 4 }, { item: 'bone', chance: 0.7, min: 1, max: 3 }, { item: 'battery', chance: 0.25, min: 1, max: 1 }] },
  { id: 'bone_stalker', name: 'Bone Stalker', emoji: '💀', minDanger: 3, maxDanger: 5, hp: 110, dmg: [12, 22], loot: [{ item: 'bone', chance: 0.9, min: 2, max: 4 }, { item: 'monster_hide', chance: 0.6, min: 1, max: 2 }, { item: 'raw_meat', chance: 0.5, min: 2, max: 3 }] },
  { id: 'night_wraith', name: 'Night Wraith', emoji: '👻', minDanger: 4, maxDanger: 5, hp: 130, dmg: [16, 26], loot: [{ item: 'monster_hide', chance: 0.7, min: 1, max: 3 }, { item: 'circuit', chance: 0.2, min: 1, max: 1 }, { item: 'raw_meat', chance: 0.5, min: 2, max: 3 }] },
  { id: 'iron_behemoth', name: 'Iron Behemoth', emoji: '🦏', minDanger: 4, maxDanger: 5, hp: 220, dmg: [20, 34], loot: [{ item: 'raw_meat', chance: 1, min: 4, max: 6 }, { item: 'monster_hide', chance: 0.9, min: 2, max: 4 }, { item: 'iron_ingot', chance: 0.5, min: 1, max: 3 }] },
] as MonsterDef[]).map((m) => [m.id, m]));

export interface BanditDef { name: string; hp: number; dmg: [number, number] }
/** Bandits scale with the city danger level. */
export function banditFor(danger: number): BanditDef {
  return { name: ['Pickpocket', 'Street Thug', 'Road Bandit', 'Warband Raider', 'Warlord Enforcer'][danger - 1] ?? 'Bandit', hp: 20 + danger * 18, dmg: [3 + danger * 2, 7 + danger * 3] };
}

// ------------------------------------------------------------------ cities
export const REGIONS = ['ashfall', 'rustbelt', 'glasslands', 'deadmarsh', 'ironcoast'] as const;
export type Region = (typeof REGIONS)[number];

/** [name, region, archetype, danger 1-5, radiation 0-1, storm factor] */
type Row = [string, Region, Archetype, number, number, number];
const CITY_ROWS: Row[] = [
  // Ashfall: gentle starter region
  ['Cinder Gate', 'ashfall', 'suburb', 1, 0, 0.8], ['Ember Hollow', 'ashfall', 'farmland', 1, 0, 0.9],
  ['Soot Market', 'ashfall', 'mall', 1, 0, 1.0], ['Lantern Row', 'ashfall', 'downtown', 2, 0, 1.0],
  ['Kiln Town', 'ashfall', 'industrial', 2, 0.05, 1.1], ['Pale Orchard', 'ashfall', 'farmland', 1, 0, 0.8],
  ['Dusthaven', 'ashfall', 'junkyard', 2, 0, 1.2], ['Gray Chapel', 'ashfall', 'medical', 2, 0, 0.9],
  ['Ashwick', 'ashfall', 'suburb', 2, 0.05, 1.0], ['Low Beacon', 'ashfall', 'harbor', 2, 0, 1.3],
  // Rustbelt: industry
  ['Ironvale', 'rustbelt', 'industrial', 3, 0.1, 1.1], ['Gearfall', 'rustbelt', 'junkyard', 2, 0, 1.0],
  ['Boilerton', 'rustbelt', 'industrial', 3, 0.1, 1.2], ['Slag End', 'rustbelt', 'wasteland', 3, 0.3, 1.0],
  ['Piston Heights', 'rustbelt', 'downtown', 3, 0.05, 1.1], ['Rivet City', 'rustbelt', 'industrial', 3, 0.1, 1.0],
  ['Coalmouth', 'rustbelt', 'junkyard', 3, 0.1, 1.3], ['Foundry Row', 'rustbelt', 'industrial', 4, 0.15, 1.1],
  ['Bolt Ridge', 'rustbelt', 'suburb', 2, 0, 0.9], ['Cog Hollow', 'rustbelt', 'mall', 3, 0.05, 1.0],
  // Glasslands: radiation, rare tech
  ['Shardfield', 'glasslands', 'wasteland', 4, 0.5, 1.4], ['Prism Gate', 'glasslands', 'downtown', 4, 0.4, 1.3],
  ['Mirage Point', 'glasslands', 'military', 4, 0.4, 1.5], ['Fusion Flats', 'glasslands', 'industrial', 4, 0.5, 1.4],
  ['Glimmer Dunes', 'glasslands', 'wasteland', 3, 0.3, 1.5], ['Halo Station', 'glasslands', 'medical', 4, 0.4, 1.2],
  ['Vitrine', 'glasslands', 'mall', 3, 0.3, 1.3], ['Obsidian Reach', 'glasslands', 'military', 5, 0.6, 1.6],
  ['Quartz Landing', 'glasslands', 'suburb', 3, 0.3, 1.2], ['Sunscar', 'glasslands', 'junkyard', 4, 0.5, 1.5],
  // Deadmarsh: water, farms, monsters
  ['Mire Landing', 'deadmarsh', 'farmland', 3, 0.05, 1.2], ['Bogwater', 'deadmarsh', 'harbor', 3, 0.05, 1.3],
  ['Rotreed', 'deadmarsh', 'farmland', 3, 0, 1.1], ['Sinkhole Springs', 'deadmarsh', 'wasteland', 4, 0.2, 1.2],
  ['Lantern Fen', 'deadmarsh', 'suburb', 3, 0, 1.0], ['Hollow Delta', 'deadmarsh', 'harbor', 4, 0.1, 1.4],
  ['Gloam Market', 'deadmarsh', 'mall', 4, 0.1, 1.1], ['Mosswatch', 'deadmarsh', 'medical', 4, 0.1, 1.0],
  ['Thornmere', 'deadmarsh', 'farmland', 4, 0.05, 1.2], ['Black Pylon', 'deadmarsh', 'military', 5, 0.2, 1.3],
  // Ironcoast: deadliest, best loot
  ['Harbor 9', 'ironcoast', 'harbor', 4, 0.1, 1.6], ['Leviathan Docks', 'ironcoast', 'harbor', 5, 0.1, 1.7],
  ['Citadel Zero', 'ironcoast', 'military', 5, 0.3, 1.5], ['Wrecker\'s Bay', 'ironcoast', 'junkyard', 4, 0.1, 1.6],
  ['Steelspire', 'ironcoast', 'downtown', 5, 0.2, 1.4], ['Tidebreak', 'ironcoast', 'industrial', 5, 0.2, 1.7],
  ['Ghost Pier', 'ironcoast', 'mall', 4, 0.1, 1.5], ['Salt Sanctum', 'ironcoast', 'medical', 5, 0.2, 1.4],
  ['Maelstrom', 'ironcoast', 'wasteland', 5, 0.4, 1.8], ['Void\'s Edge', 'ironcoast', 'military', 5, 0.5, 1.8],
];

export interface CityDef {
  id: string; name: string; region: Region; archetype: Archetype; danger: number;
  radiation: number; stormFactor: number; banditChance: number; monsterRate: number; merchantChance: number;
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export const CITIES: CityDef[] = CITY_ROWS.map(([name, region, archetype, danger, radiation, stormFactor]) => ({
  id: slug(name), name, region, archetype, danger, radiation, stormFactor,
  // Safer cities: fewer bandits/monsters, but the merchant likes busy, dangerous places less.
  banditChance: +(0.08 + danger * 0.05).toFixed(2),
  monsterRate: +(0.18 + danger * 0.07).toFixed(2),
  merchantChance: +(0.2 - danger * 0.02).toFixed(2),
}));
export const CITY_BY_ID: Record<string, CityDef> = Object.fromEntries(CITIES.map((c) => [c.id, c]));
export const START_CITIES = ['cinder_gate', 'ember_hollow', 'soot_market', 'pale_orchard'];

export function findCity(q: string): CityDef | undefined {
  const s = slug(q);
  return CITY_BY_ID[s] ?? CITIES.find((c) => c.name.toLowerCase() === q.trim().toLowerCase()) ?? CITIES.find((c) => c.id.startsWith(s));
}

/** Travel energy cost: 5 within a region, +6 per region hop. */
export function travelCost(from: CityDef, to: CityDef): number {
  if (from.id === to.id) return 0;
  const hops = Math.abs(REGIONS.indexOf(from.region) - REGIONS.indexOf(to.region));
  return 5 + hops * 6;
}
