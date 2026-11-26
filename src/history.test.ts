import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addPoint, DAY, downsample, fullInDays, growthOf, KEEP_MS } from './history.ts';
import { bytesText, pctText, rateText } from './format.ts';
import type { SizePoint } from './types.ts';

const T0 = Date.parse('2026-11-26T00:00:00Z');
const H = 3_600_000;
const GB = 1e9;

test('growth counts what the jobs added: a nightly cleanup does not hide the pace', () => {
  // 2 GB an hour for a day, a cleanup at 04:00 back to 1 GB.
  const ps: SizePoint[] = [];
  let b = 30 * GB;
  for (let h = 0; h <= 24; h++) {
    if (h === 4) b = 1 * GB;
    else if (h > 0) b += 2 * GB;
    ps.push({ at: T0 + h * H, bytes: b });
  }
  const g = growthOf(ps, T0 + 24 * H);
  assert.equal(g.spanMs, 24 * H);
  assert.ok(Math.abs(g.perDay! - 46 * GB) < 1e6, String(g.perDay));
  // Net: from 30 GB to 41 GB in a day.
  assert.ok(Math.abs(g.netPerDay! - 11 * GB) < 1e6, String(g.netPerDay));
});

test('too little history: no growth figure; a short history is scaled to a day', () => {
  assert.deepEqual(growthOf([{ at: T0, bytes: 1 }], T0), { perDay: null, netPerDay: null, spanMs: 0 });
  assert.equal(growthOf([{ at: T0, bytes: 1 }, { at: T0 + H, bytes: 2 }], T0 + H).perDay, null);
  const g = growthOf([{ at: T0, bytes: 0 }, { at: T0 + 3 * H, bytes: 3 * GB }], T0 + 3 * H);
  assert.equal(g.perDay, 24 * GB);
});

test('the point just before the window counts its first increase', () => {
  const ps = [{ at: T0 - 20 * 60_000, bytes: 0 }, { at: T0 + 10 * 60_000, bytes: 1 * GB }, { at: T0 + DAY - 20 * 60_000, bytes: 1 * GB }];
  const g = growthOf(ps, T0 + DAY);
  assert.ok(g.perDay! > 0.9 * GB);
});

test('full in N days; never when shrinking or flat', () => {
  assert.equal(fullInDays(48 * GB, 24 * GB), 2);
  assert.equal(fullInDays(48 * GB, 0), null);
  assert.equal(fullInDays(48 * GB, -5 * GB), null);
  assert.equal(fullInDays(null, 5 * GB), null);
  assert.equal(fullInDays(0, 5 * GB), 0);
});

test('history: old points dropped, out-of-order ones replaced; sparkline keeps the peak of each slice', () => {
  let ps: SizePoint[] = [];
  for (let i = 0; i < 10; i++) ps = addPoint(ps, { at: T0 + i * DAY, bytes: i });
  assert.ok(ps.every((p) => p.at > T0 + 9 * DAY - KEEP_MS));
  assert.equal(ps.length, 7);
  const s = downsample([{ at: T0, bytes: 5 }, { at: T0 + 1, bytes: 9 }, { at: T0 + 3 * H, bytes: 2 }], 4, T0, T0 + 4 * H);
  assert.deepEqual(s, [9, null, null, 2]);
});

test('sizes and rates in each language’s numbers', () => {
  assert.equal(bytesText('en', 27.94e9), '27.9 GB');
  assert.equal(bytesText('es', 27.94e9), '27,9 GB');
  assert.equal(bytesText('de', 561.2e6), '561 MB');
  assert.equal(bytesText('en', 999.97e6), '1.0 GB');
  assert.equal(bytesText('en', 1.25e12), '1.3 TB');
  assert.equal(bytesText('en', 0), '0 B');
  assert.equal(rateText('es', 38e9), '+38 GB/día');
  assert.equal(rateText('de', 2.1e9), '+2,1 GB/Tag');
  assert.equal(rateText('zh-Hans', 38e9), '+38 GB/天');
  assert.match(pctText('es', 0.198), /^20\s%$/);
});
