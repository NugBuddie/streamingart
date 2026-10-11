import { randomInt } from 'node:crypto';

/** mulberry32 — tiny deterministic PRNG so mission/storm/merchant outcomes are replayable from a seed. */
export class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0; }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number { return min + Math.floor(this.next() * (max - min + 1)); }
  chance(p: number): boolean { return this.next() < p; }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length)]; }
  weighted<T>(arr: readonly T[], w: (t: T) => number): T {
    const total = arr.reduce((a, t) => a + w(t), 0);
    let r = this.next() * total;
    for (const t of arr) { r -= w(t); if (r < 0) return t; }
    return arr[arr.length - 1];
  }
}

/** FNV-1a string hash -> 32-bit seed. Used to derive deterministic RNGs from idempotency keys. */
export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export const freshSeed = (): number => randomInt(1, 2 ** 31 - 1);
