/**
 * How fast the caches grow, and when the disk is full at that pace.
 *
 * The sizes are measured rarely (every 30 min by default) and kept for a
 * few days in the plugin's data folder. A nightly cleanup makes the total
 * drop, so the net change over a day says little about the pace the jobs
 * fill the disk with; the growth shown counts only the increases between
 * measurements (what the jobs added), over the last day or what there is
 * of it. The net change is worked out as well.
 */
import type { Growth, SizePoint } from './types.ts';

export const DAY = 86_400_000;
/** Growth needs at least this much history to be shown. */
export const MIN_SPAN_MS = 2 * 3_600_000;
/** Kept on disk. */
export const KEEP_MS = 7 * DAY;
export const MAX_POINTS = 2000;

/** Adds a point and drops the ones older than `KEEP_MS` (and over `MAX_POINTS`). */
export function addPoint(points: SizePoint[], p: SizePoint): SizePoint[] {
  const out = points.filter((x) => x.at < p.at && x.at > p.at - KEEP_MS);
  out.push(p);
  return out.slice(-MAX_POINTS);
}

/** Growth over the last `windowMs` (a day by default). */
export function growthOf(points: SizePoint[], now: number, windowMs = DAY): Growth {
  const ps = points.filter((p) => p.at <= now && p.at >= now - windowMs).sort((a, b) => a.at - b.at);
  // The point just before the window, so the first increase in it counts.
  const before = points.filter((p) => p.at < now - windowMs).sort((a, b) => b.at - a.at)[0];
  if (before && ps.length && ps[0]!.at - before.at < windowMs / 4) ps.unshift(before);
  if (ps.length < 2) return { perDay: null, netPerDay: null, spanMs: 0 };
  const span = ps[ps.length - 1]!.at - ps[0]!.at;
  if (span < MIN_SPAN_MS) return { perDay: null, netPerDay: null, spanMs: span };
  let up = 0;
  for (let i = 1; i < ps.length; i++) up += Math.max(0, ps[i]!.bytes - ps[i - 1]!.bytes);
  const net = ps[ps.length - 1]!.bytes - ps[0]!.bytes;
  return { perDay: (up / span) * DAY, netPerDay: (net / span) * DAY, spanMs: span };
}

/** Days until `freeBytes` are gone at `perDay`; null when not growing. */
export function fullInDays(freeBytes: number | null | undefined, perDay: number | null | undefined): number | null {
  if (freeBytes == null || perDay == null || !(perDay > 0)) return null;
  return Math.max(0, freeBytes / perDay);
}

/** At most `n` points for a sparkline: the largest in each slice of time, so peaks before a cleanup show. */
export function downsample(points: SizePoint[], n: number, from: number, to: number): (number | null)[] {
  const out: (number | null)[] = new Array(n).fill(null);
  if (to <= from) return out;
  for (const p of points) {
    if (p.at < from || p.at > to) continue;
    const i = Math.min(n - 1, Math.floor(((p.at - from) / (to - from)) * n));
    out[i] = Math.max(out[i] ?? 0, p.bytes);
  }
  return out;
}
