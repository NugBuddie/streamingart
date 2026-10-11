/**
 * Crafting recipes. `station` decides where it can be made:
 *  hand | workbench | furnace | stove | purifier  (non-hand stations must be built in the shelter)
 * `power` is drawn from the shelter power bank (furnace/purifier need electricity).
 */
export type Station = 'hand' | 'workbench' | 'furnace' | 'stove' | 'purifier';
export type RecipeKind = 'item' | 'equipment' | 'structure' | 'robot';

export interface Recipe {
  id: string;
  name: string;
  station: Station;
  kind: RecipeKind;
  inputs: Record<string, number>;
  /** item id -> qty (item/equipment), or structure id for kind=structure */
  output: string;
  outputQty: number;
  power?: number;
  desc?: string;
}

const r = (x: Recipe) => x;

/** Tool tiers. Each tier needs the previous material tier; steel & adamantium need the furnace chain. */
const TIERS: { k: string; n: string; station: Station; inputs: Record<string, number> }[] = [
  { k: 'scrap', n: 'Scrap', station: 'workbench', inputs: { scrap: 10, wood: 3, cloth: 1 } },
  { k: 'copper', n: 'Copper', station: 'workbench', inputs: { copper_ingot: 4, wood: 3, rope: 1 } },
  { k: 'iron', n: 'Iron', station: 'workbench', inputs: { iron_ingot: 4, wood: 3, rope: 1 } },
  { k: 'steel', n: 'Forged Steel', station: 'workbench', inputs: { steel_ingot: 4, wood: 3, rope: 2 } },
  { k: 'adamantium', n: 'Adamantium', station: 'workbench', inputs: { adamantium_ingot: 4, steel_ingot: 1, wood: 3, rope: 2 } },
];
const toolRecipes = TIERS.flatMap((t) => (['axe', 'pickaxe'] as const).map((type) => r({
  id: `${t.k}_${type}`, name: `${t.n} ${type === 'axe' ? 'Axe' : 'Pickaxe'}`, station: t.station, kind: 'equipment', inputs: t.inputs, output: `${t.k}_${type}`, outputQty: 1,
})));

export const RECIPES: Recipe[] = [
  // hand — no shelter needed: pick up branches & small stones, make quick (fragile) stone tools
  r({ id: 'stone_axe', name: 'Stone Axe', station: 'hand', kind: 'equipment', inputs: { branch: 2, small_stone: 3 }, output: 'stone_axe', outputQty: 1, desc: 'Quick and crude — breaks after ~12 uses.' }),
  r({ id: 'stone_pickaxe', name: 'Stone Pickaxe', station: 'hand', kind: 'equipment', inputs: { branch: 2, small_stone: 3 }, output: 'stone_pickaxe', outputQty: 1, desc: 'Quick and crude — breaks after ~12 uses.' }),
  r({ id: 'club', name: 'Wooden Club', station: 'hand', kind: 'equipment', inputs: { branch: 4, cloth: 1 }, output: 'club', outputQty: 1 }),
  r({ id: 'workbench', name: 'Workbench', station: 'hand', kind: 'structure', inputs: { wood: 8, stone: 4, branch: 4 }, output: 'workbench', outputQty: 1, desc: 'Needs your shelter.' }),
  // hand
  r({ id: 'bandage', name: 'Bandage', station: 'hand', kind: 'item', inputs: { cloth: 2 }, output: 'bandage', outputQty: 1 }),
  r({ id: 'pebbles', name: 'Pebbles ×10', station: 'hand', kind: 'item', inputs: { scrap: 1 }, output: 'pebbles', outputQty: 10 }),
  r({ id: 'rope', name: 'Rope', station: 'hand', kind: 'item', inputs: { cloth: 3 }, output: 'rope', outputQty: 1 }),

  // workbench: ammo
  r({ id: 'arrows', name: 'Arrows ×5', station: 'workbench', kind: 'item', inputs: { wood: 2, scrap: 1 }, output: 'arrows', outputQty: 5 }),
  r({ id: 'bullets', name: 'Bullets ×5', station: 'workbench', kind: 'item', inputs: { scrap: 2, gunpowder: 2 }, output: 'bullets', outputQty: 5 }),
  r({ id: 'medkit', name: 'Medkit', station: 'workbench', kind: 'item', inputs: { bandage: 2, cloth: 2, clean_water: 1 }, output: 'medkit', outputQty: 1 }),
  // workbench: weapons
  r({ id: 'bat', name: 'Bat', station: 'workbench', kind: 'equipment', inputs: { wood: 4, scrap: 3 }, output: 'bat', outputQty: 1 }),
  r({ id: 'knife', name: 'Knife', station: 'workbench', kind: 'equipment', inputs: { iron_ingot: 1, scrap: 2, cloth: 1 }, output: 'knife', outputQty: 1 }),
  r({ id: 'spear', name: 'Spear', station: 'workbench', kind: 'equipment', inputs: { wood: 3, iron_ingot: 1, rope: 1 }, output: 'spear', outputQty: 1 }),
  r({ id: 'slingshot', name: 'Slingshot', station: 'workbench', kind: 'equipment', inputs: { wood: 2, rope: 1, cloth: 1 }, output: 'slingshot', outputQty: 1 }),
  r({ id: 'bow', name: 'Bow', station: 'workbench', kind: 'equipment', inputs: { wood: 4, rope: 2, cloth: 1 }, output: 'bow', outputQty: 1 }),
  r({ id: 'rifle', name: 'Rifle', station: 'workbench', kind: 'equipment', inputs: { iron_ingot: 8, wood: 3, scrap: 8, circuit: 1 }, output: 'rifle', outputQty: 1 }),
  r({ id: 'ratchet', name: 'Ratchet', station: 'workbench', kind: 'equipment', inputs: { iron_ingot: 6, scrap: 12, wire: 2, circuit: 1 }, output: 'ratchet', outputQty: 1, desc: 'Special scavenging tool' }),
  // workbench: robot
  r({ id: 'scav_bot', name: 'Scav-Bot (companion)', station: 'workbench', kind: 'robot', inputs: { circuit: 4, battery: 3, iron_ingot: 6, wire: 6 }, output: 'scav_bot', outputQty: 1 }),
  // workbench: structures
  r({ id: 'repair_bench', name: 'Repair Bench', station: 'workbench', kind: 'structure', inputs: { scrap: 10, wood: 4, iron_ingot: 2 }, output: 'repair_bench', outputQty: 1 }),
  r({ id: 'water_purifier', name: 'Water Purifier', station: 'workbench', kind: 'structure', inputs: { scrap: 12, wire: 3, iron_ingot: 3 }, output: 'water_purifier', outputQty: 1 }),
  r({ id: 'power_bank', name: 'Power Bank', station: 'workbench', kind: 'structure', inputs: { battery: 3, wire: 4, scrap: 8, circuit: 1 }, output: 'power_bank', outputQty: 1 }),
  r({ id: 'furnace', name: 'Furnace', station: 'workbench', kind: 'structure', inputs: { stone: 20, scrap: 10 }, output: 'furnace', outputQty: 1 }),
  r({ id: 'stove', name: 'Stove', station: 'workbench', kind: 'structure', inputs: { stone: 12, scrap: 6, wood: 3 }, output: 'stove', outputQty: 1 }),
  r({ id: 'turret', name: 'Auto Turret', station: 'workbench', kind: 'structure', inputs: { iron_ingot: 6, circuit: 2, wire: 4, battery: 1 }, output: 'turret', outputQty: 1 }),
  r({ id: 'trap', name: 'Spike Trap', station: 'workbench', kind: 'structure', inputs: { scrap: 6, wood: 2, rope: 1 }, output: 'trap', outputQty: 1 }),
  r({ id: 'planter', name: 'Roof Planter', station: 'workbench', kind: 'structure', inputs: { scrap: 4, wood: 6, cloth: 2 }, output: 'planter', outputQty: 1 }),

  // furnace — burns wood/coal (no electricity needed), so the metal chain works from day one
  r({ id: 'smelt_scrap', name: 'Smelt Iron Ingot (from scrap)', station: 'furnace', kind: 'item', inputs: { scrap: 4, wood: 1 }, output: 'iron_ingot', outputQty: 1 }),
  r({ id: 'smelt_copper', name: 'Smelt Copper Ingot', station: 'furnace', kind: 'item', inputs: { copper_ore: 2, wood: 1 }, output: 'copper_ingot', outputQty: 1 }),
  r({ id: 'smelt_iron', name: 'Smelt Iron Ingot (from ore)', station: 'furnace', kind: 'item', inputs: { iron_ore: 2, wood: 1 }, output: 'iron_ingot', outputQty: 1 }),
  r({ id: 'forge_steel', name: 'Forge Steel Ingot', station: 'furnace', kind: 'item', inputs: { iron_ingot: 2, coal: 2 }, output: 'steel_ingot', outputQty: 1 }),
  r({ id: 'forge_adamantium', name: 'Forge Adamantium Ingot', station: 'furnace', kind: 'item', inputs: { adamantite_ore: 3, steel_ingot: 1, coal: 3 }, output: 'adamantium_ingot', outputQty: 1 }),

  // purifier
  r({ id: 'purify_water', name: 'Purify Water ×2', station: 'purifier', kind: 'item', inputs: { dirty_water: 2 }, output: 'clean_water', outputQty: 2, power: 1 }),

  // stove: cooking (raw 1-5 food -> 20-50 food)
  r({ id: 'cook_meat', name: 'Cooked Meat', station: 'stove', kind: 'item', inputs: { raw_meat: 1 }, output: 'cooked_meat', outputQty: 1 }),
  r({ id: 'bake_potato', name: 'Baked Potato', station: 'stove', kind: 'item', inputs: { potato: 2 }, output: 'baked_potato', outputQty: 1 }),
  r({ id: 'bake_bread', name: 'Corn Bread', station: 'stove', kind: 'item', inputs: { corn: 2 }, output: 'corn_bread', outputQty: 1 }),
  r({ id: 'cook_veggie_stew', name: 'Veggie Stew', station: 'stove', kind: 'item', inputs: { carrot: 1, cabbage: 1, tomato: 1, clean_water: 1 }, output: 'veggie_stew', outputQty: 1 }),
  r({ id: 'cook_chili', name: 'Pepper Chili', station: 'stove', kind: 'item', inputs: { pepper: 2, raw_meat: 1, tomato: 1 }, output: 'pepper_chili', outputQty: 1 }),
  r({ id: 'cook_meat_stew', name: 'Hearty Meat Stew', station: 'stove', kind: 'item', inputs: { cooked_meat: 1, potato: 2, carrot: 1, clean_water: 1 }, output: 'meat_stew', outputQty: 1 }),
  // stove: brewing
  r({ id: 'brew_tea', name: 'Brew Tea', station: 'stove', kind: 'item', inputs: { tea_leaves: 1, clean_water: 1 }, output: 'tea', outputQty: 1 }),
  r({ id: 'brew_coffee', name: 'Brew Coffee', station: 'stove', kind: 'item', inputs: { coffee_beans: 1, clean_water: 1 }, output: 'coffee', outputQty: 1 }),
  r({ id: 'brew_beer', name: 'Brew Beer', station: 'stove', kind: 'item', inputs: { hops: 2, corn: 1, clean_water: 1 }, output: 'beer', outputQty: 1 }),
];

RECIPES.push(...toolRecipes);

export const RECIPE_BY_ID: Record<string, Recipe> = Object.fromEntries(RECIPES.map((x) => [x.id, x]));

/** Max quantity of each structure a shelter can hold. Others are single-instance (upgradeable). */
export const STRUCTURE_LIMITS: Record<string, number> = {
  workbench: 1, repair_bench: 1, water_purifier: 1, power_bank: 1, furnace: 1, stove: 1,
  turret: 4, trap: 8, planter: 6,
};
export const STRUCTURE_NAMES: Record<string, string> = {
  workbench: '🛠️ Workbench', repair_bench: '🔨 Repair Bench', water_purifier: '🚰 Water Purifier',
  power_bank: '🔋 Power Bank', furnace: '🔥 Furnace', stove: '🍳 Stove',
  turret: '🤖 Auto Turret', trap: '🪤 Spike Trap', planter: '🪴 Roof Planter',
};
