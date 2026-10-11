/** Big abandoned buildings for crew raids: one per city archetype. Better loot than solo missions, but guarded in waves. */
import type { Archetype } from './world.js';

export interface BuildingDef {
  id: string;
  name: string;
  emoji: string;
  /** guaranteed haul scaled by how many waves the crew clears: item -> [min, max] */
  bonus: Record<string, [number, number]>;
}

export const BUILDINGS: Record<Archetype, BuildingDef> = {
  downtown: { id: 'corp_tower', name: 'Sunken Corporate Tower', emoji: '🏢', bonus: { circuit: [3, 5], wire: [6, 10], coffee_beans: [2, 4], battery: [2, 3] } },
  industrial: { id: 'steel_mill', name: 'Derelict Steel Mill', emoji: '🏭', bonus: { iron_ingot: [5, 8], battery: [3, 5], circuit: [2, 3], scrap: [20, 30] } },
  suburb: { id: 'gated_estate', name: 'Abandoned Gated Estate', emoji: '🏘️', bonus: { canned_food: [4, 7], tea_leaves: [3, 5], cloth: [8, 12], seed_tomato: [2, 3] } },
  farmland: { id: 'seed_bank', name: 'Collapsed Seed Bank', emoji: '🌾', bonus: { seed_corn: [2, 3], seed_pepper: [2, 3], seed_berries: [1, 2], clean_water: [4, 6], hops: [3, 5] } },
  military: { id: 'armory', name: 'Sealed Armory Bunker', emoji: '🪖', bonus: { bullets: [10, 16], gunpowder: [5, 8], iron_ingot: [4, 6], circuit: [2, 3], medkit: [1, 2] } },
  harbor: { id: 'cargo_terminal', name: 'Flooded Cargo Terminal', emoji: '⚓', bonus: { rope: [5, 8], iron_ingot: [3, 5], clean_water: [4, 8], scrap: [15, 25], hops: [2, 4] } },
  medical: { id: 'hospital_wing', name: 'Quarantined Hospital Wing', emoji: '🏥', bonus: { medkit: [2, 4], bandage: [6, 10], clean_water: [4, 8], circuit: [2, 3] } },
  wasteland: { id: 'rad_lab', name: 'Irradiated Research Lab', emoji: '☢️', bonus: { circuit: [3, 4], battery: [3, 5], monster_hide: [3, 5], bone: [4, 7] } },
  junkyard: { id: 'car_cathedral', name: 'Crushed-Car Cathedral', emoji: '🚗', bonus: { battery: [4, 6], circuit: [2, 4], iron_ingot: [4, 7], wire: [8, 12], scrap: [25, 35] } },
  mall: { id: 'megamall', name: 'Buried Megamall Atrium', emoji: '🛍️', bonus: { coffee_beans: [3, 5], tea_leaves: [3, 5], seed_tomato: [2, 3], cloth: [8, 14], canned_food: [4, 6], rope: [3, 5] } },
};
