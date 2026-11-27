/**
 * `runners/compact`: the runner and its caches in one tile. Three figures
 * (jobs running, caches on disk with their growth, free disk with when it
 * runs out) side by side in a wide tile, one over another in a tall one,
 * or one line in a strip.
 */
import { defineWidget, type Graphics } from '@kiosko/sdk';
import { clamp, clipped, dataOf, diskLevel, drawFigure, figureBig, drawLines, drawMessage, freeText, headLine, storageFigures, fullText, growthIsRate, growthLevel, growthText, levelInk, MIN_PX, pendingParts, runnerParts, runningNow, jobsWord, SOURCE, type Ctx, type Figure, type Part } from './common.ts';
import { demoData } from './demo.ts';
import { bytesParts } from './format.ts';
import { L } from './i18n.ts';
import { DISK_FREE, IDLE, JOBS_RUNNING, NOTHING, NOTHING_HOW, ON_DISK, REMOTE_DISK, WAITING } from './labels.ts';
import type { RunnersData } from './types.ts';

export function figures(ctx: Ctx, d: RunnersData): Figure[] {
  const out: Figure[] = [];
  const n = runningNow(d);
  const head = headLine(ctx, d);
  if (n !== null || head) {
    const state = d.local ? runnerParts(ctx, d.local) : null;
    const pending = pendingParts(ctx, d);
    out.push({ label: ctx.t(JOBS_RUNNING), value: n === null ? '—' : String(n), sub: pending.length ? pending : (state?.parts.slice(0, 2) ?? head?.parts.slice(0, 2) ?? []), level: head?.level === 'bad' ? 'bad' : 'none' });
  }
  out.push(...storageFigures(ctx, d));
  return out;
}

function render(g: Graphics, ctx: Ctx): void {
  const d = dataOf(ctx.sources);
  if (!d) return drawMessage(g, ctx, ctx.t(WAITING));
  const figs = figures(ctx, d);
  if (!figs.length) return drawMessage(g, ctx, ctx.t(NOTHING), ctx.t(NOTHING_HOW));
  const { box } = ctx;

  // A strip: one or two lines of parts.
  const n = figs.length;
  const across = box.w >= box.h * 1.3;
  // Figures need room: 120 px across each, or 60 px tall each; else lines.
  if (box.h < 64 || (across ? box.w / n < 120 : box.h / n < 60)) {
    const head = headLine(ctx, d);
    const running = runningNow(d);
    const first: Part[] = [...(running !== null ? [{ text: running === 0 ? ctx.t(IDLE) : `${running} ${jobsWord(ctx, running)}`, color: ctx.theme.colors.ink }] : head?.parts.slice(0, 1) ?? []), ...pendingParts(ctx, d)];
    const l = d.local;
    const second: Part[] = [];
    if (l?.sizes) second.push({ text: bytesParts(ctx.locale, l.sizes.total.bytes).join(' '), color: ctx.theme.colors.ink, bold: true });
    const g2 = growthText(ctx, d);
    if (g2) second.push({ text: g2, ...(growthIsRate(d) ? { color: levelInk(ctx, growthLevel(d)) } : {}) });
    const free = freeText(ctx, d);
    if (free) second.push({ text: free, color: levelInk(ctx, diskLevel(d)) });
    const full = fullText(ctx, d);
    if (full) second.push({ text: full });
    const two = box.h >= 2 * 1.42 * MIN_PX + 4;
    const s = clamp(Math.round((two ? box.h / 2 : box.h) * 0.48), MIN_PX, 22);
    const lines = two ? [{ parts: first, ...(head?.level ? { level: head.level } : {}) }, { parts: second }] : [{ parts: [...first, ...second], ...(head?.level ? { level: head.level } : {}) }];
    const lh = s * 1.42;
    const shown = lines.filter((x) => x.parts.length);
    drawLines(g, ctx, shown, box.x, box.y + (box.h - shown.length * lh) / 2, box.w, box.y + box.h, s);
    return;
  }

  // Figures: side by side when wide, stacked when tall.
  const gap = clamp(Math.round(Math.min(box.w, box.h) * 0.06), 6, 24);
  const w = across ? (box.w - gap * (n - 1)) / n : box.w;
  const h = across ? box.h : (box.h - gap * (n - 1)) / n;
  // The same size for every value, so a short one doesn't shout over the others.
  const big = Math.min(...figs.map((f) => figureBig(g, ctx, f, w, h)));
  for (let i = 0; i < n; i++) drawFigure(g, ctx, figs[i]!, across ? box.x + i * (w + gap) : box.x, across ? box.y : box.y + i * (h + gap), w, h, big);
}

export const compact = defineWidget({
  id: 'compact',
  name: L('Runner and caches', 'Runner y cachés', 'Runner und Caches', 'Runner 与缓存', 'Runner 與快取'),
  description: L(
    'The runner and its caches in one tile: jobs running (and waiting), the caches on disk with their daily growth, and the free disk with when it runs out.',
    'El runner y sus cachés en una sola tarjeta: trabajos en marcha (y en cola), las cachés en disco con su crecimiento diario, y el disco libre con cuándo se acaba.',
    'Der Runner und seine Caches in einer Kachel: laufende (und wartende) Jobs, die Caches auf der Platte mit ihrem täglichen Wachstum, und der freie Platz mit dem Zeitpunkt, an dem er ausgeht.',
    '一张卡片看 Runner 和缓存：运行中（及排队）的作业、磁盘上的缓存及每日增长、剩余磁盘空间及何时占满。',
    '一張卡片看 Runner 和快取：執行中（及排隊）的作業、磁碟上的快取及每日增長、剩餘磁碟空間及何時占滿。',
  ),
  icon: 'gauge',
  category: 'dev',
  tags: ['ci', 'gitlab-runner', 'docker', 'cache', 'disk'],
  size: { min: { w: 160, h: 30 }, preferred: { w: 480, h: 140 } },
  sources: [SOURCE],
  redraw: 'minute',
  /** No runner, no API and no metrics to count jobs from: the "No runner set up" message. */
  empty: ({ sources }) => {
    const d = dataOf(sources);
    return !!d && !d.local && !d.gitlab && !d.github && runningNow(d) === null;
  },
  render(g, ctx) {
    clipped(g, ctx, () => render(g, ctx));
  },
  demo: ({ now: at }) => ({ sources: { [SOURCE]: demoData(at) } }),
});
