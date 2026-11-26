import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import * as kit from '@loksly/lcd-canvas-kit';
import { THEMES, createBaseContext, defaultsOf, type WidgetDefinition } from '@kiosko/sdk';
import { renderWidget } from '@kiosko/sdk/testing';
import { MIN_PX, SOURCE } from './common.ts';
import { demoData } from './demo.ts';
import type { RunnersData } from './types.ts';
import { cache } from './widget-cache.ts';
import { compact } from './widget-compact.ts';
import { now, shortRef } from './widget-now.ts';

const NOW = Date.parse('2026-11-26T21:10:00+01:00');
const SIZES = [{ w: 172, h: 320 }, { w: 240, h: 70 }, { w: 320, h: 200 }, { w: 480, h: 240 }, { w: 800, h: 160 }, { w: 1920, h: 140 }, { w: 200, h: 36 }, { w: 320, h: 480 }];
const LOCALES = ['en', 'es', 'zh-Hant'];
const WIDGETS = [now, cache, compact] as WidgetDefinition<any, any>[];

/** The demo, and the states that paint differently. */
function variants(): [string, RunnersData][] {
  const d = demoData(NOW);
  const L = d.local!;
  const first: RunnersData = { ...d, local: { ...L, sizes: null, history: [], growth: { perDay: null, netPerDay: null, spanMs: 0, added: 0, reliable: false }, fullInDays: null, nextSizesAt: NOW + 50_000 } };
  const measuring: RunnersData = { ...d, local: { ...L, sizes: null, measuring: true, nextSizesAt: null, history: [] } };
  const down: RunnersData = { ...d, local: { ...L, error: 'not-running', runners: [], jobs: [], sizes: null, disk: null, history: [] }, gitlab: null, github: null, metrics: null };
  const stopped: RunnersData = { ...d, local: { ...L, runners: [{ ...L.runners[0]!, state: 'exited', status: 'Exited (137) 2 minutes ago' }], jobs: [] } };
  const apiOnly: RunnersData = { ...d, local: null, metrics: null };
  const idle: RunnersData = { ...d, local: { ...L, jobs: [], timer: { ...L.timer!, result: 'exit-code' } }, gitlab: { ...d.gitlab!, pending: 0, oldestPendingAt: null, error: 'unauthorized' }, github: null, metrics: null };
  const remote: RunnersData = { ...d, local: { ...L, remote: true, disk: null, fullInDays: null } };
  const full: RunnersData = { ...d, local: { ...L, disk: { ...L.disk!, freeBytes: 9e9, freeShare: 9 / 243.8 }, fullInDays: 0.25 } };
  const nothing: RunnersData = { ...d, local: null, gitlab: null, github: null, metrics: null };
  return [['demo', d], ['first', first], ['measuring', measuring], ['down', down], ['stopped', stopped], ['api only', apiOnly], ['idle', idle], ['remote', remote], ['full', full], ['nothing', nothing]];
}

/** The states every language is tried in; the rest in English (the harness counts every pixel around the box: it is slow). */
const ALL_LANGUAGES = new Set(['demo', 'first', 'down', 'api only']);

test('every widget paints at 8 sizes × 3 languages, in every state, without throwing or spilling', () => {
  for (const w of WIDGETS)
    for (const [name, data] of variants())
      for (const size of SIZES)
        for (const locale of ALL_LANGUAGES.has(name) ? LOCALES : ['en']) {
          const r = renderWidget(w, { size, locale, now: NOW, sources: { [SOURCE]: data } });
          const where = `${w.id} ${name} ${size.w}x${size.h} ${locale}`;
          assert.equal(r.error, undefined, where);
          assert.equal(r.outside, 0, where);
          assert.ok(r.texts.length > 0, `${where} paints text`);
        }
});

/** Paints a widget and returns every text drawn, with its size. */
function sizesOf(w: WidgetDefinition<any, any>, data: RunnersData, size: { w: number; h: number }, locale: string) {
  const texts: { text: string; size: number }[] = [];
  const spy = { ...kit, drawTracked: (g: never, text: string, x: number, y: number, o: { size: number }) => (texts.push({ text, size: o.size }), kit.drawTracked(g, text, x, y, o as never)) };
  const g = createCanvas(size.w, size.h).getContext('2d');
  const theme = THEMES[0]!;
  w.render(g as never, { ...createBaseContext({ now: NOW, locale }), options: w.options ? defaultsOf(w.options as never) : {}, data: undefined, sources: { [SOURCE]: data }, working: true, box: { x: 0, y: 0, w: size.w, h: size.h }, theme, fonts: theme.fonts, kit: spy, canvas: { createCanvas }, preview: false } as never);
  return texts;
}

test('nothing under 11 px, in every language, size and state', () => {
  for (const w of WIDGETS)
    for (const [name, data] of variants())
      for (const size of SIZES)
        for (const locale of LOCALES) {
          const small = sizesOf(w, data, size, locale).filter((x) => x.size < MIN_PX);
          assert.deepEqual(small, [], `${w.id} ${name} ${size.w}x${size.h} ${locale}`);
        }
});

test('now: the runner up with its version, the jobs with project and branch, the waiting ones, in Spanish', () => {
  const r = renderWidget(now, { size: { w: 480, h: 480 }, locale: 'es', now: NOW });
  const all = r.texts.join(' | ');
  for (const t of ['En marcha', 'gitlab-runner', '19.5.1', '2/4', 'web', 'main', 'api', '!173', '3 en cola', 'la más antigua 9 min', 'GitLab', '1 desconectado']) assert.ok(r.texts.includes(t), `${t} in ${all}`);
  assert.equal(shortRef('refs/pull/12/merge'), '#12');
});

test('now: a stopped runner in words; Docker not answering; only the APIs', () => {
  const v = Object.fromEntries(variants());
  const s = renderWidget(now, { size: { w: 320, h: 200 }, locale: 'en', now: NOW, sources: { [SOURCE]: v.stopped } });
  assert.ok(s.texts.includes('Down') && s.texts.includes('0/4'), s.texts.join(' | '));
  const d = renderWidget(now, { size: { w: 320, h: 200 }, locale: 'en', now: NOW, sources: { [SOURCE]: v.down } });
  assert.ok(d.texts.includes('Docker is not answering'), d.texts.join(' | '));
  const a = renderWidget(now, { size: { w: 320, h: 200 }, locale: 'en', now: NOW, sources: { [SOURCE]: v['api only'] } });
  assert.ok(a.texts.includes('GitLab') && a.texts.includes('2'), a.texts.join(' | '));
  const n = renderWidget(now, { size: { w: 320, h: 200 }, locale: 'en', now: NOW, sources: { [SOURCE]: v.nothing } });
  assert.equal(n.texts[0], 'No runner set up');
});

test('cache: the total with Intl, cache and builds, growth a day, free space and when it is full, the cleanup', () => {
  const r = renderWidget(cache, { size: { w: 320, h: 480 }, locale: 'de', now: NOW });
  const all = r.texts.join(' | ');
  assert.ok(r.texts.includes('27,9') && r.texts.includes(' GB') && r.texts.includes('62 Volumes'), all);
  assert.ok(r.texts.some((t) => /^Cache 6,6 GB$/.test(t)) && r.texts.some((t) => /^Builds 21,3 GB$/.test(t)), all);
  assert.ok(r.texts.includes('+28,5 GB/Tag'), all);
  assert.ok(r.texts.some((t) => /^48,3 GB frei \(20\s%\)$/.test(t)) && r.texts.some((t) => /^voll in 1 T\. /.test(t)), all);
  assert.ok(r.texts.some((t) => /^bereinigt vor 16/.test(t)), all);
  const en = renderWidget(cache, { size: { w: 320, h: 480 }, locale: 'en', now: NOW });
  assert.ok(en.texts.includes('27.9'), en.texts.join(' | '));
});

test('cache: before the first measurement, while measuring, and with Docker elsewhere', () => {
  const v = Object.fromEntries(variants());
  const f = renderWidget(cache, { size: { w: 320, h: 200 }, locale: 'en', now: NOW, sources: { [SOURCE]: v.first } });
  assert.ok(f.texts.includes('First measurement in 1 min'), f.texts.join(' | '));
  assert.ok(f.texts.some((t) => t.startsWith('48.3 GB free')), f.texts.join(' | '));
  const m = renderWidget(cache, { size: { w: 320, h: 200 }, locale: 'es', now: NOW, sources: { [SOURCE]: v.measuring } });
  assert.ok(m.texts.includes('Midiendo los volúmenes…'), m.texts.join(' | '));
  const r = renderWidget(cache, { size: { w: 320, h: 200 }, locale: 'en', now: NOW, sources: { [SOURCE]: v.remote } });
  assert.ok(r.texts.includes('disk not visible from here'), r.texts.join(' | '));
});

test('compact: three figures, the free disk in red when nearly full', () => {
  const r = renderWidget(compact, { size: { w: 800, h: 160 }, locale: 'en', now: NOW });
  assert.ok(r.texts.includes('2') && r.texts.includes('27.9') && r.texts.includes('48.3'), r.texts.join(' | '));
  const full = renderWidget(compact, { size: { w: 800, h: 160 }, locale: 'en', now: NOW, sources: { [SOURCE]: Object.fromEntries(variants()).full } });
  assert.ok(full.texts.includes('9.0') && full.texts.includes('full in 6 h'), full.texts.join(' | '));
});

test('before any data: a waiting message', () => {
  for (const w of WIDGETS) {
    const r = renderWidget(w, { size: { w: 320, h: 200 }, locale: 'en', demo: false });
    assert.deepEqual(r.texts, ['Reading the runners…']);
  }
});

test('growth on thin history: what was added and in how long, neutral, no "full in"; a rate from 12 h on', () => {
  const d = demoData(NOW);
  const L = d.local!;
  const thin: RunnersData = { ...d, local: { ...L, growth: { perDay: 27.8e9, netPerDay: 27.8e9, spanMs: 2.2 * 3_600_000, added: 2.5e9, reliable: false }, fullInDays: null } };
  for (const w of [cache, compact]) {
    const r = renderWidget(w, { size: { w: 320, h: 480 }, locale: 'es', now: NOW, sources: { [SOURCE]: thin } });
    const all = r.texts.join(' | ');
    assert.ok(r.texts.some((t) => t === '+2,5 GB en 2 h 12'), all);
    assert.ok(!/GB\/día|lleno en/.test(all), all);
  }
  const flat: RunnersData = { ...d, local: { ...L, growth: { perDay: 0, netPerDay: 0, spanMs: 2 * 3_600_000, added: 0, reliable: false }, fullInDays: null } };
  const f = renderWidget(cache, { size: { w: 320, h: 480 }, locale: 'en', now: NOW, sources: { [SOURCE]: flat } });
  assert.ok(f.texts.includes('measuring growth (2 h of data)'), f.texts.join(' | '));
  const r = renderWidget(cache, { size: { w: 320, h: 480 }, locale: 'es', now: NOW });
  assert.ok(r.texts.includes('+28,5 GB/día'), r.texts.join(' | '));
});

test('now: a tall tile shows the caches and free disk under the runner', () => {
  const r = renderWidget(now, { size: { w: 172, h: 320 }, locale: 'en', now: NOW });
  assert.ok(r.texts.includes('27.9') && r.texts.includes('48.3'), r.texts.join(' | '));
});
