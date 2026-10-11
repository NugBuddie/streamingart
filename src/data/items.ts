/**
 * Static item catalogue. Adding an item = adding one entry here; no migration needed
 * because the database only stores item ids.
 *
 * kinds:
 *  - material/ammo/seed/crop/food/drink/medical are STACKABLE (player_inventory / vault_contents)
 *  - weapon/tool are EQUIPMENT INSTANCES with durability (player_equipment)
 */
export type ItemKind = 'material' | 'ammo' | 'seed' | 'crop' | 'food' | 'drink' | 'medical' | 'weapon' | 'tool';

export interface WeaponStats {
  min: number;
  max: number;
  /** ranged weapons need `ammo` (1 unit per round) */
  ranged?: boolean;
  ammo?: string;
  /** multiplier when smashing doors / turrets */
  breach: number;
}

export interface ItemDef {
  id: string;
  name: string;
  emoji: string;
  kind: ItemKind;
  /** abstract trade value, 1 scrap = 1. Used by merchant fairness + loot balance. */
  value: number;
  food?: number;
  water?: number;
  energy?: number;
  hp?: number;
  /** chance of getting sick (hp loss) when consumed */
  sickChance?: number;
  weapon?: WeaponStats;
  durability?: number;
  /** gathering tools: what they do and how good they are (1 stone … 6 adamantium) */
  tool?: { type: 'axe' | 'pickaxe'; tier: number };
  desc?: string;
}

const defs: ItemDef[] = [
  // ---- materials ----
  { id: 'scrap', name: 'Scrap', emoji: '🔩', kind: 'material', value: 1 },
  { id: 'wood', name: 'Wood', emoji: '🪵', kind: 'material', value: 2 },
  { id: 'cloth', name: 'Cloth', emoji: '🧵', kind: 'material', value: 2 },
  { id: 'wire', name: 'Wire', emoji: '➰', kind: 'material', value: 3 },
  { id: 'rope', name: 'Rope', emoji: '🪢', kind: 'material', value: 4 },
  { id: 'iron_ingot', name: 'Iron Ingot', emoji: '🧱', kind: 'material', value: 5, desc: 'Smelted from scrap in a furnace.' },
  { id: 'battery', name: 'Battery', emoji: '🔋', kind: 'material', value: 12, desc: 'Charges a power bank (+10 power).' },
  { id: 'circuit', name: 'Circuit Board', emoji: '💾', kind: 'material', value: 20 },
  { id: 'gunpowder', name: 'Gunpowder', emoji: '💥', kind: 'material', value: 6 },
  { id: 'monster_hide', name: 'Monster Hide', emoji: '🦴', kind: 'material', value: 6 },
  { id: 'bone', name: 'Bone', emoji: '🦴', kind: 'material', value: 3 },
  { id: 'tea_leaves', name: 'Tea Leaves', emoji: '🍃', kind: 'material', value: 4 },
  { id: 'coffee_beans', name: 'Coffee Beans', emoji: '🫘', kind: 'material', value: 5 },
  { id: 'hops', name: 'Hops', emoji: '🌿', kind: 'material', value: 4 },
  // gathered by hand / with tools
  { id: 'branch', name: 'Branch', emoji: '🌿', kind: 'material', value: 0.5, desc: 'Picked up by hand.' },
  { id: 'small_stone', name: 'Small Stone', emoji: '🪨', kind: 'material', value: 0.5, desc: 'Picked up by hand.' },
  { id: 'stone', name: 'Stone', emoji: '🧱', kind: 'material', value: 1.5, desc: 'Mined with a pickaxe. Shelters, furnaces and stoves are built from it.' },
  { id: 'coal', name: 'Coal', emoji: '⚫', kind: 'material', value: 3 },
  { id: 'copper_ore', name: 'Copper Ore', emoji: '🟠', kind: 'material', value: 4 },
  { id: 'iron_ore', name: 'Iron Ore', emoji: '🔶', kind: 'material', value: 4 },
  { id: 'adamantite_ore', name: 'Adamantite Ore', emoji: '💠', kind: 'material', value: 18 },
  { id: 'copper_ingot', name: 'Copper Ingot', emoji: '🟧', kind: 'material', value: 7 },
  { id: 'steel_ingot', name: 'Forged Steel Ingot', emoji: '⬛', kind: 'material', value: 14 },
  { id: 'adamantium_ingot', name: 'Adamantium Ingot', emoji: '🔷', kind: 'material', value: 45 },

  // ---- ammo ----
  { id: 'pebbles', name: 'Pebbles', emoji: '⚪', kind: 'ammo', value: 0.5 },
  { id: 'arrows', name: 'Arrows', emoji: '🏹', kind: 'ammo', value: 2 },
  { id: 'bullets', name: 'Bullets', emoji: '🔸', kind: 'ammo', value: 5 },

  // ---- food (raw produce is poor, cooking multiplies it) ----
  { id: 'canned_food', name: 'Canned Food', emoji: '🥫', kind: 'food', value: 8, food: 15 },
  { id: 'raw_meat', name: 'Raw Meat', emoji: '🥩', kind: 'food', value: 4, food: 4, sickChance: 0.3 },
  { id: 'cooked_meat', name: 'Cooked Meat', emoji: '🍖', kind: 'food', value: 10, food: 28 },
  { id: 'baked_potato', name: 'Baked Potato', emoji: '🥔', kind: 'food', value: 9, food: 20 },
  { id: 'corn_bread', name: 'Corn Bread', emoji: '🍞', kind: 'food', value: 11, food: 24 },
  { id: 'veggie_stew', name: 'Veggie Stew', emoji: '🥘', kind: 'food', value: 16, food: 35 },
  { id: 'pepper_chili', name: 'Pepper Chili', emoji: '🌶️', kind: 'food', value: 20, food: 42, energy: 5 },
  { id: 'meat_stew', name: 'Hearty Meat Stew', emoji: '🍲', kind: 'food', value: 26, food: 50, energy: 8 },

  // ---- crops (raw, 1-5 food) ----
  { id: 'potato', name: 'Potato', emoji: '🥔', kind: 'crop', value: 3, food: 3 },
  { id: 'carrot', name: 'Carrot', emoji: '🥕', kind: 'crop', value: 3, food: 2 },
  { id: 'cabbage', name: 'Cabbage', emoji: '🥬', kind: 'crop', value: 4, food: 3 },
  { id: 'tomato', name: 'Tomato', emoji: '🍅', kind: 'crop', value: 4, food: 4 },
  { id: 'corn', name: 'Corn', emoji: '🌽', kind: 'crop', value: 5, food: 5 },
  { id: 'pepper', name: 'Pepper', emoji: '🫑', kind: 'crop', value: 5, food: 3 },
  { id: 'berries', name: 'Berries', emoji: '🫐', kind: 'crop', value: 5, food: 5, water: 3 },

  // ---- seeds ----
  { id: 'seed_potato', name: 'Potato Seeds', emoji: '🌱', kind: 'seed', value: 8 },
  { id: 'seed_carrot', name: 'Carrot Seeds', emoji: '🌱', kind: 'seed', value: 8 },
  { id: 'seed_cabbage', name: 'Cabbage Seeds', emoji: '🌱', kind: 'seed', value: 9 },
  { id: 'seed_tomato', name: 'Tomato Seeds', emoji: '🌱', kind: 'seed', value: 10 },
  { id: 'seed_corn', name: 'Corn Seeds', emoji: '🌱', kind: 'seed', value: 12 },
  { id: 'seed_pepper', name: 'Pepper Seeds', emoji: '🌱', kind: 'seed', value: 12 },
  { id: 'seed_berries', name: 'Berry Seeds', emoji: '🌱', kind: 'seed', value: 14 },

  // ---- drinks (water bar max = 100) ----
  { id: 'dirty_water', name: 'Dirty Water', emoji: '🚰', kind: 'drink', value: 1, water: 8, sickChance: 0.4, desc: 'Purify it before drinking or watering crops.' },
  { id: 'clean_water', name: 'Clean Water', emoji: '💧', kind: 'drink', value: 4, water: 25 },
  { id: 'tea', name: 'Herbal Tea', emoji: '🍵', kind: 'drink', value: 12, water: 40 },
  { id: 'coffee', name: 'Black Coffee', emoji: '☕', kind: 'drink', value: 14, water: 35, energy: 15 },
  { id: 'beer', name: 'Scav Beer', emoji: '🍺', kind: 'drink', value: 12, water: 45 },

  // ---- medical ----
  { id: 'bandage', name: 'Bandage', emoji: '🩹', kind: 'medical', value: 6, hp: 20 },
  { id: 'medkit', name: 'Medkit', emoji: '🧰', kind: 'medical', value: 25, hp: 60 },

  // ---- weapons & tools (equipment instances) ----
  { id: 'bat', name: 'Bat', emoji: '🏏', kind: 'weapon', value: 20, durability: 45, weapon: { min: 10, max: 16, breach: 1.3 } },
  { id: 'knife', name: 'Knife', emoji: '🔪', kind: 'weapon', value: 25, durability: 60, weapon: { min: 8, max: 12, breach: 0.6 } },
  { id: 'spear', name: 'Spear', emoji: '🔱', kind: 'weapon', value: 35, durability: 40, weapon: { min: 12, max: 18, breach: 0.8 } },
  { id: 'slingshot', name: 'Slingshot', emoji: '🪃', kind: 'weapon', value: 25, durability: 60, weapon: { min: 8, max: 14, ranged: true, ammo: 'pebbles', breach: 0.3 } },
  { id: 'bow', name: 'Bow', emoji: '🏹', kind: 'weapon', value: 55, durability: 50, weapon: { min: 14, max: 22, ranged: true, ammo: 'arrows', breach: 0.5 } },
  { id: 'rifle', name: 'Rifle', emoji: '🔫', kind: 'weapon', value: 180, durability: 80, weapon: { min: 28, max: 42, ranged: true, ammo: 'bullets', breach: 1.6 } },
  { id: 'stone_axe', name: 'Stone Axe', emoji: '🪓', kind: 'tool', value: 6, durability: 12, tool: { type: 'axe', tier: 1 }, desc: 'Chops wood (tier 1).' },
  { id: 'stone_pickaxe', name: 'Stone Pickaxe', emoji: '⛏️', kind: 'tool', value: 6, durability: 12, tool: { type: 'pickaxe', tier: 1 }, desc: 'Mines stone and ore (tier 1).' },
  { id: 'scrap_axe', name: 'Scrap Axe', emoji: '🪓', kind: 'tool', value: 20, durability: 30, tool: { type: 'axe', tier: 2 }, desc: 'Chops wood (tier 2).' },
  { id: 'scrap_pickaxe', name: 'Scrap Pickaxe', emoji: '⛏️', kind: 'tool', value: 20, durability: 30, tool: { type: 'pickaxe', tier: 2 }, desc: 'Mines stone and ore (tier 2).' },
  { id: 'copper_axe', name: 'Copper Axe', emoji: '🪓', kind: 'tool', value: 40, durability: 45, tool: { type: 'axe', tier: 3 }, desc: 'Chops wood (tier 3).' },
  { id: 'copper_pickaxe', name: 'Copper Pickaxe', emoji: '⛏️', kind: 'tool', value: 40, durability: 45, tool: { type: 'pickaxe', tier: 3 }, desc: 'Mines stone and ore (tier 3).' },
  { id: 'iron_axe', name: 'Iron Axe', emoji: '🪓', kind: 'tool', value: 70, durability: 70, tool: { type: 'axe', tier: 4 }, desc: 'Chops wood (tier 4).' },
  { id: 'iron_pickaxe', name: 'Iron Pickaxe', emoji: '⛏️', kind: 'tool', value: 70, durability: 70, tool: { type: 'pickaxe', tier: 4 }, desc: 'Mines stone and ore (tier 4).' },
  { id: 'steel_axe', name: 'Forged Steel Axe', emoji: '🪓', kind: 'tool', value: 140, durability: 110, tool: { type: 'axe', tier: 5 }, desc: 'Chops wood (tier 5).' },
  { id: 'steel_pickaxe', name: 'Forged Steel Pickaxe', emoji: '⛏️', kind: 'tool', value: 140, durability: 110, tool: { type: 'pickaxe', tier: 5 }, desc: 'Mines stone and ore (tier 5).' },
  { id: 'adamantium_axe', name: 'Adamantium Axe', emoji: '🪓', kind: 'tool', value: 400, durability: 200, tool: { type: 'axe', tier: 6 }, desc: 'Chops wood (tier 6).' },
  { id: 'adamantium_pickaxe', name: 'Adamantium Pickaxe', emoji: '⛏️', kind: 'tool', value: 400, durability: 200, tool: { type: 'pickaxe', tier: 6 }, desc: 'Mines stone and ore (tier 6).' },
  { id: 'club', name: 'Wooden Club', emoji: '🏑', kind: 'weapon', value: 8, durability: 25, weapon: { min: 5, max: 9, breach: 0.8 } },
  { id: 'ratchet', name: 'Ratchet', emoji: '🔧', kind: 'tool', value: 150, durability: 30, desc: 'Strips cars & machinery: +40% salvage yield and bonus batteries/circuits.' },
];

export const ITEMS: Record<string, ItemDef> = Object.fromEntries(defs.map((d) => [d.id, d]));

export const FISTS: WeaponStats = { min: 2, max: 5, breach: 0.2 };

export function item(id: string): ItemDef {
  const d = ITEMS[id];
  if (!d) throw new Error(`Unknown item ${id}`);
  return d;
}

export const isEquipment = (id: string) => ITEMS[id]?.kind === 'weapon' || ITEMS[id]?.kind === 'tool';

export function label(id: string, qty?: number): string {
  const d = ITEMS[id];
  const n = d ? `${d.emoji} ${d.name}` : id;
  return qty === undefined ? n : `${qty}× ${n}`;
}

/** Find an item by id or (case-insensitive) display name. */
export function findItem(q: string): ItemDef | undefined {
  const s = q.trim().toLowerCase().replace(/\s+/g, '_');
  return ITEMS[s] ?? defs.find((d) => d.name.toLowerCase() === q.trim().toLowerCase());
}
