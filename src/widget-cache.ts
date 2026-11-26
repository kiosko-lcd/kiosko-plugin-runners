/**
 * `runners/cache`: what the runner's volumes cost on disk. Their total
 * and how many there are, split into cache (`/cache`) and builds (the
 * clones, `/builds`) and how much of it is for protected refs; how fast
 * they grow, with the last day as bars (the nightly cleanup is the drop);
 * the free space on the disk holding Docker's data and, at this pace, when
 * it is full; and when the cleanup timer last ran.
 */
import { defineWidget, type Graphics } from '@kiosko/sdk';
import { bar, clamp, clipped, dataOf, diskLevel, drawLines, drawMessage, drawSpark, fitSize, freeText, fullText, growthLevel, growthText, levelColor, levelInk, MIN_PX, SOURCE, timerParts, type Ctx, type Line, type Part } from './common.ts';
import { demoData } from './demo.ts';
import { bytesParts, bytesText, pctText } from './format.ts';
import { downsample } from './history.ts';
import { L } from './i18n.ts';
import { BUILDS, CACHE, ENGINE_ERROR, FIRST_IN, GROWTH_SOON, LAST_DAY, MEASURED, MEASURING, NOT_GROWING, NOTHING, NOTHING_HOW, PROTECTED, REMOTE_DISK, VOLUMES, WAITING, fill } from './labels.ts';
import type { RunnersData } from './types.ts';

const DAY = 86_400_000;

function legend(ctx: Ctx, d: RunnersData): Part[] {
  const s = d.local!.sizes!;
  const c = ctx.theme.colors;
  const parts: Part[] = [
    { text: `${ctx.t(CACHE)} ${bytesText(ctx.locale, s.cache.bytes)}`, color: c.accent },
    { text: `${ctx.t(BUILDS)} ${bytesText(ctx.locale, s.builds.bytes)}`, color: c.ink },
  ];
  if (s.total.bytes > 0) parts.push({ text: `${ctx.t(PROTECTED)} ${pctText(ctx.locale, s.protected.bytes / s.total.bytes)}` });
  return parts;
}

function growthPart(ctx: Ctx, d: RunnersData): Part {
  const g = growthText(ctx, d);
  if (g === null) return { text: ctx.t(GROWTH_SOON) };
  if ((d.local!.growth.perDay ?? 0) <= 0) return { text: ctx.t(NOT_GROWING) };
  return { text: g, color: levelInk(ctx, growthLevel(d)), bold: true };
}

function diskParts(ctx: Ctx, d: RunnersData): Part[] {
  const l = d.local!;
  if (l.remote) return [{ text: ctx.t(REMOTE_DISK) }];
  const free = freeText(ctx, d);
  if (!free) return [];
  const level = diskLevel(d);
  const out: Part[] = [{ text: free, color: levelInk(ctx, level) }];
  const full = fullText(ctx, d);
  if (full) out.push({ text: full, color: level === 'ok' ? undefined : levelColor(ctx, level) });
  return out;
}

function footParts(ctx: Ctx, d: RunnersData): Part[] {
  const l = d.local!;
  const out: Part[] = [];
  const t = timerParts(ctx, d);
  if (t) out.push(t);
  if (l.measuring) out.push({ text: ctx.t(MEASURING) });
  else if (l.sizes) out.push({ text: fill(ctx.t(MEASURED), { ago: ctx.fmt.ago(l.sizes.at) }) });
  return out;
}

/** Why there are no sizes yet: measuring now, or when the first measurement is. */
function noSizes(ctx: Ctx, d: RunnersData): string {
  const l = d.local!;
  if (l.measuring || l.nextSizesAt === null) return ctx.t(MEASURING);
  return fill(ctx.t(FIRST_IN), { d: ctx.fmt.duration(Math.max(60_000, l.nextSizesAt - ctx.now), { round: 'up' }) });
}

/** The used/free bar of the disk, and the share the runner volumes take of it. */
function diskBar(g: Graphics, ctx: Ctx, d: RunnersData, x: number, y: number, w: number, h: number): void {
  const disk = d.local?.disk;
  if (!disk) return;
  const c = ctx.theme.colors;
  const used = 1 - disk.freeShare;
  const runners = Math.min(used, (d.local!.sizes?.total.bytes ?? 0) / disk.totalBytes);
  bar(g, x, y, w, h, c.surfaceEdge);
  bar(g, x, y, w * used, h, c.inkFaint);
  const level = diskLevel(d);
  bar(g, x + w * (used - runners), y, w * runners, h, level === 'ok' || level === 'none' ? c.accent : levelColor(ctx, level));
}

/** The cache/builds bar. */
function kindBar(g: Graphics, ctx: Ctx, d: RunnersData, x: number, y: number, w: number, h: number): void {
  const s = d.local!.sizes!;
  const c = ctx.theme.colors;
  const t = Math.max(1, s.total.bytes);
  bar(g, x, y, w, h, c.surfaceEdge);
  bar(g, x, y, (w * s.cache.bytes) / t, h, c.accent);
  bar(g, x + (w * s.cache.bytes) / t, y, (w * s.builds.bytes) / t, h, c.ink);
}

function spark(ctx: Ctx, d: RunnersData, n: number): (number | null)[] {
  return downsample(d.local!.history, n, ctx.now - DAY, ctx.now);
}

function render(g: Graphics, ctx: Ctx): void {
  const d = dataOf(ctx.sources);
  if (!d) return drawMessage(g, ctx, ctx.t(WAITING));
  const l = d.local;
  if (!l) return drawMessage(g, ctx, ctx.t(NOTHING), ctx.t(NOTHING_HOW));
  if (l.error && !l.sizes) return drawMessage(g, ctx, fill(ctx.t(ENGINE_ERROR[l.error] ?? ENGINE_ERROR.other!), { engine: l.engine === 'podman' ? 'Podman' : 'Docker' }));
  const { box, kit, theme } = ctx;
  const c = theme.colors;
  const sizes = l.sizes;
  const total = sizes ? bytesParts(ctx.locale, sizes.total.bytes) : null;

  // One line: 29 GB · +36 GB/day · 48 GB free (20 %) · full in 1 d.
  if (box.h < 60) {
    const s = clamp(Math.round(box.h * 0.42), MIN_PX, 22);
    const parts: Part[] = sizes ? [{ text: total!.join(' '), color: c.ink, bold: true }, growthPart(ctx, d)] : [{ text: noSizes(ctx, d) }];
    drawLines(g, ctx, [{ parts: [...parts, ...diskParts(ctx, d)] }], box.x, box.y + (box.h - s * 1.42) / 2, box.w, box.y + box.h, s);
    return;
  }

  const s = clamp(Math.round(Math.min(box.h * 0.085, box.w / 19)), MIN_PX, 20);
  const lh = s * 1.42;
  const label = { size: s, family: theme.fonts.sans, color: c.inkDim };
  const count = sizes ? fill(ctx.t(VOLUMES), { n: String(sizes.total.count) }) : '';

  // A wide strip: the total, the last day's bars, the details.
  if (box.w >= box.h * 3.2) {
    const s = clamp(Math.round(box.h * 0.14), MIN_PX, 20);
    const lh = s * 1.42;
    const label = { size: s, family: theme.fonts.sans, color: c.inkDim };
    const bs = clamp(Math.round(box.h * 0.46), MIN_PX, 84);
    const unit = clamp(Math.round(bs * 0.42), MIN_PX, 34);
    let x = box.x;
    if (total) {
      const top = box.y + (box.h - bs * 1.05 - s * 1.4) / 2;
      const w = kit.drawTracked(g, total[0], x, top + bs * 0.88, { size: bs, family: theme.fonts.sansBold, color: c.ink });
      const uw = kit.drawTracked(g, ` ${total[1]}`, x + w, top + bs * 0.88, { size: unit, family: theme.fonts.sans, color: c.inkDim });
      const cw = kit.drawTracked(g, count, x, top + bs * 1.05 + s * 1.05, label);
      x += Math.max(w + uw, cw) + s * 1.6;
    } else {
      const msg = noSizes(ctx, d);
      kit.drawTracked(g, msg, x, box.y + box.h / 2 + s * 0.36, label);
      x += kit.measureTracked(g, msg, label) + s * 1.6;
    }
    const right = Math.max(s * 16, (box.x + box.w - x) * 0.55);
    const sw = Math.min(box.x + box.w - x - right - s, box.h * 3);
    if (sw > s * 5 && l.history.length > 1) {
      const top = box.y + s * 1.6;
      drawLines(g, ctx, [{ parts: [growthPart(ctx, d), { text: ctx.t(LAST_DAY) }] }], x, box.y, sw, top, s);
      drawSpark(g, ctx, spark(ctx, d, Math.max(8, Math.floor(sw / 4))), x, top + s * 0.3, sw, box.y + box.h - top - s * 0.3, c.accent);
      x += sw + s * 1.6;
    }
    const lines: Line[] = [...(sizes ? [{ parts: legend(ctx, d) }] : []), { parts: diskParts(ctx, d) }, ...(sw > s * 5 && l.history.length > 1 ? [] : [{ parts: [growthPart(ctx, d)] }]), { parts: footParts(ctx, d) }].filter((x) => x.parts.length);
    const fit = lines.slice(0, Math.max(1, Math.floor(box.h / lh)));
    drawLines(g, ctx, fit, x, box.y + (box.h - fit.length * lh) / 2, box.x + box.w - x, box.y + box.h, s);
    return;
  }

  // Stacked: total, cache/builds bar and legend, growth and bars, disk, footer.
  let y = box.y;
  const bottom = box.y + box.h;
  const foot = footParts(ctx, d);
  const disk = diskParts(ctx, d);
  // What must fit under the top part: the growth line, the disk line and its bar, the footer.
  const reserve = lh * (1 + (disk.length ? 1 : 0) + (foot.length ? 1 : 0)) + (l.disk ? s * 0.7 : 0);
  if (total) {
    // With a day of history, the bars matter more than a huge total.
    const share = l.history.length > 1 && box.h < 400 ? 0.22 : 0.32;
    const room = Math.max(MIN_PX * 1.2, Math.min(box.h - reserve - lh * 1.6, box.h * share));
    const unit = clamp(Math.round(room * 0.4), MIN_PX, 34);
    const uw = kit.measureTracked(g, ` ${total[1]}`, { size: unit, family: theme.fonts.sans });
    const cw = kit.measureTracked(g, count, label);
    const side = box.w - cw - s > room * 2.4 + uw;
    const bs = fitSize(g, ctx, total[0], box.w - uw - (side ? cw + s : 0), Math.min(room / 1.1, 100));
    const base = y + bs * 0.92;
    const w = kit.drawTracked(g, total[0], box.x, base, { size: bs, family: theme.fonts.sansBold, color: c.ink });
    kit.drawTracked(g, ` ${total[1]}`, box.x + w, base, { size: Math.min(unit, bs), family: theme.fonts.sans, color: c.inkDim });
    if (side) kit.drawTracked(g, count, box.x + box.w - cw, base, label);
    y += bs * 1.12;
    if (!side && bottom - y - reserve >= lh) y = drawLines(g, ctx, [{ parts: [{ text: count }] }], box.x, y, box.w, bottom, s);
    if (bottom - y - reserve >= s * 0.6 + lh) {
      kindBar(g, ctx, d, box.x, y + s * 0.15, box.w, Math.max(3, s * 0.45));
      y += s * 0.75;
      y = drawLines(g, ctx, [{ parts: legend(ctx, d) }], box.x, y, box.w, bottom, s);
    }
  } else {
    y = drawLines(g, ctx, [{ parts: [{ text: noSizes(ctx, d), color: c.inkDim }] }], box.x, y, box.w, bottom, clamp(Math.round(s * 1.2), MIN_PX, 24));
  }
  // The growth line and, with room left, the last day's bars under it.
  y = drawLines(g, ctx, [{ parts: [growthPart(ctx, d), ...(l.history.length > 1 ? [{ text: ctx.t(LAST_DAY) }] : [])] }], box.x, y, box.w, bottom, s);
  const sparkH = bottom - y - (reserve - lh) - s * 0.4;
  if (sparkH >= s * 1.3 && l.history.length > 1) {
    const h = Math.min(sparkH, box.h * 0.3);
    drawSpark(g, ctx, spark(ctx, d, Math.max(8, Math.min(48, Math.floor(box.w / 5)))), box.x, y + s * 0.1, box.w, h - s * 0.2, c.accent);
    y += h;
  }
  if (l.disk && bottom - y >= lh + s * 0.7) {
    diskBar(g, ctx, d, box.x, y + s * 0.3, box.w, Math.max(3, s * 0.4));
    y += s * 0.7;
  }
  drawLines(g, ctx, [{ parts: disk }, { parts: foot }], box.x, y, box.w, bottom, s);
}

export const cache = defineWidget({
  id: 'cache',
  name: L('Runner caches on disk', 'Cachés del runner en disco', 'Runner-Caches auf der Platte', '磁盘上的 Runner 缓存', '磁碟上的 Runner 快取'),
  description: L(
    "What the runner's volumes take on disk: the total and how many, cache and builds, the share for protected refs; how fast they grow, with the last day as bars; the free space where Docker keeps them and when it runs out at this pace; and when the cleanup last ran.",
    'Lo que ocupan en disco los volúmenes del runner: el total y cuántos son, caché y builds, la parte de ramas protegidas; lo rápido que crecen, con el último día en barras; el espacio libre donde Docker los guarda y cuándo se acaba a este ritmo; y cuándo corrió la limpieza por última vez.',
    'Was die Volumes des Runners auf der Platte belegen: Summe und Anzahl, Cache und Builds, der Anteil geschützter Refs; wie schnell sie wachsen, mit dem letzten Tag als Balken; der freie Platz, wo Docker sie ablegt, und wann er bei diesem Tempo voll ist; und wann die Bereinigung zuletzt lief.',
    'Runner 卷占用的磁盘空间：总量和数量、缓存与构建目录、受保护分支的占比；增长速度，并以柱状图显示最近一天；Docker 存放它们的磁盘剩余空间，以及按此速度何时占满；以及上次清理的时间。',
    'Runner 磁碟區占用的磁碟空間：總量和數量、快取與建置目錄、受保護分支的占比；增長速度，並以長條圖顯示最近一天；Docker 存放它們的磁碟剩餘空間，以及依此速度何時占滿；以及上次清理的時間。',
  ),
  icon: 'hard-drive',
  category: 'dev',
  tags: ['ci', 'gitlab-runner', 'docker', 'cache', 'disk'],
  size: { min: { w: 160, h: 30 }, preferred: { w: 320, h: 240 } },
  sources: [SOURCE],
  redraw: 'minute',
  render(g, ctx) {
    clipped(g, ctx, () => render(g, ctx));
  },
  demo: ({ now: at }) => ({ sources: { [SOURCE]: demoData(at) } }),
});
