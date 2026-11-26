/** What the widgets share: their source, colours, words and a few drawing helpers. */
import type { Graphics, RenderContext } from '@kiosko/sdk';
import { bytesParts, bytesText, pctText, rateText } from './format.ts';
import { ADDED_IN, DISK_FREE, ON_DISK, REMOTE_DISK, API_ERROR, BUSY, GROWTH_DATA, CLEAN_FAILED, CLEAN_MISSING, CLEAN_NEVER, CLEANED, ENGINE_ERROR, FREE, FULL_IN, FULL_NOW, IDLE, JOB, JOBS, NEVER, NO_RUNNER, OFFLINE, OLDEST, ONLINE, PAUSED, PENDING, RUNNING, STALE, STATE, UP_FOR, fill } from './labels.ts';
import type { ApiData, ApiRunner, LocalData, RunnerContainer, RunnersData } from './types.ts';

export const SOURCE = 'runners/runners';
/** The smallest text drawn, in px of the box: readable on a panel across the desk. */
export const MIN_PX = 11;

export type Ctx = RenderContext<any, any>;
export type Level = 'ok' | 'warn' | 'bad' | 'none';

export const dataOf = (sources: Record<string, unknown>): RunnersData | undefined => sources[SOURCE] as RunnersData | undefined;

export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export function levelColor(ctx: Pick<Ctx, 'theme'>, level: Level): string {
  const c = ctx.theme.colors;
  return level === 'bad' ? c.alert : level === 'warn' ? c.warn : level === 'ok' ? c.ok : c.inkDim;
}

/** Text of a value: plain ink when fine, amber or red when not. */
export function levelInk(ctx: Pick<Ctx, 'theme'>, level: Level): string {
  return level === 'ok' || level === 'none' ? ctx.theme.colors.ink : levelColor(ctx, level);
}

/** Paints inside the box only, whatever happens. */
export function clipped(g: Graphics, ctx: Ctx, paint: () => void): void {
  const { box } = ctx;
  g.save();
  g.beginPath();
  g.rect(box.x, box.y, box.w, box.h);
  g.clip();
  try {
    paint();
  } finally {
    g.restore();
  }
}

export function drawMessage(g: Graphics, ctx: Ctx, text: string, sub?: string): void {
  const { box, kit, theme } = ctx;
  const c = theme.colors;
  const size = clamp(Math.round(Math.min(box.h * 0.3, box.w / 12)), MIN_PX, 26);
  const subSize = clamp(Math.round(size * 0.66), MIN_PX, 18);
  const font = { size, family: theme.fonts.sans, color: c.inkDim };
  const f2 = { size: subSize, family: theme.fonts.sans, color: c.inkFaint };
  const lines = kit.wrapLines(g, text, box.w, box.h >= size * 3 ? 2 : 1, font);
  const subLines = sub ? kit.wrapLines(g, sub, box.w, 2, f2) : [];
  let keep = subLines.length;
  const h = (n: number) => lines.length * size * 1.25 + (n ? subSize * 0.5 + n * subSize * 1.25 : 0);
  while (keep > 0 && h(keep) > box.h) keep--;
  let y = box.y + (box.h - h(keep)) / 2;
  for (const l of lines) {
    y += size * 1.25;
    kit.drawTracked(g, l, box.x, y - size * 0.3, font);
  }
  y += subSize * 0.5;
  for (const l of subLines.slice(0, keep)) {
    y += subSize * 1.25;
    kit.drawTracked(g, l, box.x, y - subSize * 0.3, f2);
  }
}

export function dot(g: Graphics, x: number, y: number, r: number, color: string): void {
  g.save();
  g.fillStyle = color;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

export function bar(g: Graphics, x: number, y: number, w: number, h: number, color: string): void {
  if (w <= 0 || h <= 0) return;
  g.save();
  g.fillStyle = color;
  g.fillRect(Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.round(h));
  g.restore();
}

/** One piece of a line: its text and colour. */
export interface Part {
  text: string;
  color?: string;
  bold?: boolean;
}

const SEP = ' · ';

/** Width of parts joined with " · ". */
export function partsWidth(g: Graphics, ctx: Ctx, parts: Part[], size: number): number {
  const { kit, theme } = ctx;
  let w = 0;
  parts.forEach((p, i) => {
    if (i) w += kit.measureTracked(g, SEP, { size, family: theme.fonts.sans });
    w += kit.measureTracked(g, p.text, { size, family: p.bold ? theme.fonts.sansBold : theme.fonts.sans });
  });
  return w;
}

/** Draws parts joined with " · " as far as they fit in `w` (the first one cut short if even it doesn't); returns the width drawn. */
export function drawParts(g: Graphics, ctx: Ctx, parts: Part[], x: number, base: number, w: number, size: number): number {
  const { kit, theme } = ctx;
  const c = theme.colors;
  let keep = parts.length;
  while (keep > 1 && partsWidth(g, ctx, parts.slice(0, keep), size) > w) keep--;
  let cx = x;
  for (let i = 0; i < keep; i++) {
    const p = parts[i]!;
    const f = { size, family: p.bold ? theme.fonts.sansBold : theme.fonts.sans, color: p.color ?? c.inkDim };
    if (i) cx += kit.drawTracked(g, SEP, cx, base, { size, family: theme.fonts.sans, color: c.inkFaint });
    const text = keep === 1 && i === 0 ? kit.truncate(g, p.text, Math.max(0, x + w - cx), f) : p.text;
    if (text) cx += kit.drawTracked(g, text, cx, base, f);
  }
  return cx - x;
}

// ── What the data says, in words ────────────────────────────────────────────

/** The runner container's state level: red when down, amber when restarting. */
export function runnerLevel(r: RunnerContainer): Level {
  if (r.state === 'running') return r.health === 'unhealthy' ? 'bad' : 'ok';
  if (r.state === 'restarting' || r.state === 'paused' || r.state === 'created') return 'warn';
  return 'bad';
}

/** The worst of a set of levels. */
export function worst(levels: Level[]): Level {
  return levels.includes('bad') ? 'bad' : levels.includes('warn') ? 'warn' : levels.includes('ok') ? 'ok' : 'none';
}

export function engineName(l: LocalData): string {
  return l.engine === 'podman' ? 'Podman' : 'Docker';
}

/** The one line on the runner container: "Up · gitlab-runner · 19.5.1 · up 10 d". */
export function runnerParts(ctx: Ctx, l: LocalData): { level: Level; parts: Part[] } {
  if (l.error) return { level: l.error === 'missing' ? 'none' : 'bad', parts: [{ text: fill(ctx.t(ENGINE_ERROR[l.error] ?? ENGINE_ERROR.other!), { engine: engineName(l) }), color: levelInk(ctx, l.error === 'missing' ? 'none' : 'bad') }] };
  const r = l.runners[0];
  if (!r) return { level: 'none', parts: [{ text: ctx.t(NO_RUNNER) }] };
  const level = worst(l.runners.map(runnerLevel));
  const parts: Part[] = [{ text: ctx.t(STATE[r.state] ?? STATE.exited!), color: levelInk(ctx, runnerLevel(r)), bold: true }, { text: l.runners.length > 1 ? `${r.name} +${l.runners.length - 1}` : r.name, color: ctx.theme.colors.ink }];
  if (r.version) parts.push({ text: r.version });
  if (r.state === 'running' && r.startedAt) parts.push({ text: fill(ctx.t(UP_FOR), { d: ctx.fmt.duration(Math.max(60_000, ctx.now - r.startedAt), { compact: true }) }) });
  return { level, parts };
}

/** How many jobs run now: the containers on this machine, else what the metrics or the API say. */
export function runningNow(d: RunnersData): number | null {
  if (d.local && !d.local.error) return d.local.jobs.length;
  if (d.metrics && !d.metrics.error) return d.metrics.running;
  if (d.gitlab && !d.gitlab.error) return d.gitlab.running;
  if (d.github && !d.github.error) return d.github.running;
  return null;
}

export const jobsWord = (ctx: Ctx, n: number): string => ctx.t(n === 1 ? JOB : JOBS);

/** "2 jobs running" or "No jobs running". */
export function runningText(ctx: Ctx, n: number): string {
  return n === 0 ? ctx.t(IDLE) : `${n} ${jobsWord(ctx, n)} ${ctx.t(RUNNING)}`;
}

/** The API whose waiting jobs to show: the one with the oldest. */
export function pendingApi(d: RunnersData): { name: string; api: ApiData } | null {
  const list = ([['GitLab', d.gitlab], ['GitHub', d.github]] as const).filter(([, a]) => a && !a.error && a.pending > 0) as [string, ApiData][];
  if (!list.length) return null;
  list.sort((a, b) => (a[1].oldestPendingAt ?? Infinity) - (b[1].oldestPendingAt ?? Infinity));
  return { name: list[0]![0], api: list[0]![1] };
}

/** "3 pending · oldest 9 min", amber past the threshold. */
export function pendingParts(ctx: Ctx, d: RunnersData): Part[] {
  const p = pendingApi(d);
  if (!p) return [];
  const late = p.api.oldestPendingAt !== null && ctx.now - p.api.oldestPendingAt > d.thresholds.pendingMaxMs;
  const parts: Part[] = [{ text: `${p.api.pending} ${ctx.t(PENDING)}`, color: late ? ctx.theme.colors.warn : ctx.theme.colors.ink }];
  if (p.api.oldestPendingAt !== null) parts.push({ text: fill(ctx.t(OLDEST), { d: ctx.fmt.duration(Math.max(60_000, ctx.now - p.api.oldestPendingAt), { compact: true }) }), color: late ? ctx.theme.colors.warn : undefined });
  return parts;
}

export function apiStatusWord(ctx: Ctx, r: ApiRunner): { text: string; level: Level } {
  switch (r.status) {
    case 'online':
      return { text: ctx.t(r.busy ? BUSY : ONLINE), level: 'ok' };
    case 'paused':
      return { text: ctx.t(PAUSED), level: 'warn' };
    case 'stale':
      return { text: ctx.t(STALE), level: 'bad' };
    case 'never_contacted':
      return { text: ctx.t(NEVER), level: 'warn' };
    default:
      return { text: ctx.t(OFFLINE), level: 'bad' };
  }
}

/** "GitLab: 1 online, 1 offline" in short: counts by status, or why it can't be read. */
export function apiSummary(ctx: Ctx, name: string, a: ApiData): { level: Level; parts: Part[] } {
  if (a.error) return { level: 'warn', parts: [{ text: fill(ctx.t(API_ERROR), { name, why: a.error }), color: ctx.theme.colors.warn }] };
  const on = a.runners.filter((r) => r.status === 'online').length;
  const off = a.runners.length - on;
  const parts: Part[] = [{ text: name, color: ctx.theme.colors.ink }];
  if (a.runners.length) {
    parts.push({ text: `${on} ${ctx.t(ONLINE)}` });
    if (off) parts.push({ text: `${off} ${ctx.t(OFFLINE)}`, color: ctx.theme.colors.warn });
  }
  return { level: off ? 'warn' : 'ok', parts };
}

// ── Disk ───────────────────────────────────────────────────────────────────

export function diskLevel(d: RunnersData): Level {
  const disk = d.local?.disk;
  if (!disk) return 'none';
  if (disk.freeShare < d.thresholds.diskFreeMin) return 'bad';
  const full = d.local?.fullInDays;
  if (disk.freeShare < d.thresholds.diskFreeMin * 2 || (full !== null && full !== undefined && full < 3)) return 'warn';
  return 'ok';
}

export function growthLevel(d: RunnersData): Level {
  const g = d.local?.growth.perDay;
  if (g == null || !d.local?.growth.reliable) return 'none';
  return g > d.thresholds.growthMax ? 'warn' : 'ok';
}

/** "48 GB free (20 %)". */
export function freeText(ctx: Ctx, d: RunnersData): string | null {
  const disk = d.local?.disk;
  if (!disk) return null;
  return `${fill(ctx.t(FREE), { v: bytesText(ctx.locale, disk.freeBytes) })} (${pctText(ctx.locale, disk.freeShare)})`;
}

/** "full in 1 d 7 h" / "disk full", or null when not growing. */
export function fullText(ctx: Ctx, d: RunnersData): string | null {
  const f = d.local?.fullInDays;
  if (f === null || f === undefined) return null;
  if (f <= 0) return ctx.t(FULL_NOW);
  return fill(ctx.t(FULL_IN), { d: ctx.fmt.duration(Math.max(3_600_000, f * 86_400_000), { compact: true }) });
}

/**
 * "+28.5 GB/day" once there are 12 h of history; before that what was
 * added so far, "+2.5 GB in 2 h", with no rate (one big job would read as
 * tens of GB a day), or "measuring growth (2 h of data)"; null with none.
 */
export function growthText(ctx: Ctx, d: RunnersData): string | null {
  const g = d.local?.growth;
  if (!g || g.spanMs <= 0) return null;
  if (g.reliable && g.perDay !== null) return rateText(ctx.locale, g.perDay);
  const span = ctx.fmt.duration(Math.max(60_000, g.spanMs), { compact: true });
  if (g.added >= 1e8) return fill(ctx.t(ADDED_IN), { v: `+${bytesText(ctx.locale, g.added)}`, d: span });
  return fill(ctx.t(GROWTH_DATA), { d: span });
}

/** Whether `growthText` is a rate (bold, coloured by level) or a neutral note. */
export const growthIsRate = (d: RunnersData): boolean => !!d.local?.growth.reliable && d.local.growth.perDay !== null;

/** "cleaned 16 h ago", "cleanup failed"…, with its level. */
export function timerParts(ctx: Ctx, d: RunnersData): Part | null {
  const t = d.local?.timer;
  if (!t) return null;
  const c = ctx.theme.colors;
  if (!t.found) return { text: ctx.t(CLEAN_MISSING), color: c.warn };
  if (t.result && t.result !== 'success') return { text: ctx.t(CLEAN_FAILED), color: c.warn };
  if (t.lastAt === null) return { text: ctx.t(CLEAN_NEVER), color: c.warn };
  const late = ctx.now - t.lastAt > d.thresholds.timerMaxMs;
  return { text: fill(ctx.t(CLEANED), { ago: ctx.fmt.ago(t.lastAt) }), ...(late ? { color: c.warn } : {}) };
}

// ── Layout ─────────────────────────────────────────────────────────────────

/** A line of parts, with a status dot before it when `level` is set. */
export interface Line {
  parts: Part[];
  level?: Level;
}

/** Draws lines from `y` down, `size` px each, as many as fit before `bottom`; returns where it stopped. */
export function drawLines(g: Graphics, ctx: Ctx, lines: Line[], x: number, y: number, w: number, bottom: number, size: number): number {
  const lh = size * 1.42;
  for (const l of lines) {
    if (!l.parts.length) continue;
    if (y + lh > bottom + 0.5) break;
    let cx = x;
    if (l.level) {
      dot(g, x + size * 0.32, y + lh / 2, size * 0.3, levelColor(ctx, l.level));
      cx += size * 0.95;
    }
    drawParts(g, ctx, l.parts, cx, y + lh / 2 + size * 0.36, x + w - cx, size);
    y += lh;
  }
  return y;
}

/** A big figure: a small label over it, a value, a small line under it. */
export interface Figure {
  label: string;
  value: string;
  unit?: string;
  sub?: Part[];
  level: Level;
}

/** Largest size (≤ max) at which `text` fits in `w`. */
export function fitSize(g: Graphics, ctx: Ctx, text: string, w: number, max: number, bold = true): number {
  const { kit, theme } = ctx;
  let s = Math.max(MIN_PX, Math.floor(max));
  while (s > MIN_PX && kit.measureTracked(g, text, { size: s, family: bold ? theme.fonts.sansBold : theme.fonts.sans }) > w) s--;
  return s;
}

function figureMetrics(g: Graphics, ctx: Ctx, f: Figure, w: number, h: number) {
  const { kit, theme } = ctx;
  const s = clamp(Math.round(Math.min(h * 0.17, w / 9)), MIN_PX, 22);
  const hasSub = h >= s * 4.2;
  const unitSize = clamp(Math.round(s * 1.05), MIN_PX, 26);
  const unitW = f.unit ? kit.measureTracked(g, ` ${f.unit}`, { size: unitSize, family: theme.fonts.sans }) : 0;
  const room = h - s * 1.5 - (hasSub ? s * 1.5 : 0);
  const big = Math.max(MIN_PX, Math.min(fitSize(g, ctx, f.value, Math.max(10, w - unitW), Math.min(room * 0.92, 96)), Math.round(room * 0.92)));
  return { s, hasSub: hasSub && !!f.sub?.length, unitSize, unitW, big };
}

/** The value's size a figure would take alone in its cell. */
export const figureBig = (g: Graphics, ctx: Ctx, f: Figure, w: number, h: number): number => figureMetrics(g, ctx, f, w, h).big;

/** Draws a figure in its cell: label, value (shrunk to fit, at most `maxBig`), sub-line. */
export function drawFigure(g: Graphics, ctx: Ctx, f: Figure, x: number, y: number, w: number, h: number, maxBig = Infinity): void {
  const { kit, theme } = ctx;
  const c = theme.colors;
  const m = figureMetrics(g, ctx, f, w, h);
  const { s, hasSub, unitSize, unitW } = m;
  const big = Math.min(m.big, maxBig);
  const block = s * 1.5 + big * 1.08 + (hasSub ? s * 1.5 : 0);
  let top = y + Math.max(0, (h - block) / 2);
  kit.drawTracked(g, kit.truncate(g, f.label, w, { size: s, family: theme.fonts.sans }), x, top + s, { size: s, family: theme.fonts.sans, color: c.inkDim });
  top += s * 1.5;
  const vw = kit.drawTracked(g, f.value, x, top + big * 0.86, { size: big, family: theme.fonts.sansBold, color: levelInk(ctx, f.level) });
  if (f.unit && x + vw + unitW <= x + w + 0.5) kit.drawTracked(g, ` ${f.unit}`, x + vw, top + big * 0.86, { size: unitSize, family: theme.fonts.sans, color: c.inkDim });
  top += big * 1.08;
  if (hasSub) drawParts(g, ctx, f.sub!, x, top + s * 1.05, w, s);
}

/** A sparkline of bars in its box, the values scaled to their maximum; null slots are left empty. */
export function drawSpark(g: Graphics, ctx: Ctx, values: (number | null)[], x: number, y: number, w: number, h: number, color: string): void {
  const { kit, theme } = ctx;
  if (w < 8 || h < 4) return;
  const vals = values.map((v) => v ?? 0);
  const bars = kit.sparkBars(vals, w, h, { gap: values.length > w / 3 ? 0 : 1, minHeight: 0 });
  g.save();
  bar(g, x, y + h - 1, w, 1, theme.colors.inkFaint);
  g.fillStyle = color;
  for (const b of bars) if (values[b.index] !== null && b.h > 0) g.fillRect(x + b.x, y + b.y, b.w, b.h);
  g.restore();
}

// ── Shared pieces of the widgets ─────────────────────────────────────────────

/** The runner line (or, without Docker, the APIs' summary), with its level. */
export function headLine(ctx: Ctx, d: RunnersData): Line | null {
  if (d.local) {
    const r = runnerParts(ctx, d.local);
    return { parts: r.parts, level: r.level };
  }
  const apis = ([['GitLab', d.gitlab], ['GitHub', d.github]] as const).filter(([, a]) => a);
  if (!apis.length) return null;
  const s = apis.map(([n, a]) => apiSummary(ctx, n, a!));
  return { parts: s.flatMap((x) => x.parts), level: worst(s.map((x) => x.level)) };
}

/** The caches on disk and the free disk as figures (for `compact`, and under `now` when it has room). */
export function storageFigures(ctx: Ctx, d: RunnersData): Figure[] {
  const out: Figure[] = [];
  const l = d.local;
  if (l?.sizes) {
    const [v, u] = bytesParts(ctx.locale, l.sizes.total.bytes);
    const g = growthText(ctx, d);
    out.push({ label: ctx.t(ON_DISK), value: v, unit: u, sub: g ? [{ text: g, ...(growthIsRate(d) ? { color: levelInk(ctx, growthLevel(d)) } : {}) }] : [], level: 'none' });
  }
  if (l?.disk) {
    const [v, u] = bytesParts(ctx.locale, l.disk.freeBytes);
    const full = fullText(ctx, d);
    const level = diskLevel(d);
    out.push({ label: ctx.t(DISK_FREE), value: v, unit: u, sub: full ? [{ text: full, color: levelInk(ctx, level) }] : [], level: level === 'ok' ? 'none' : level });
  } else if (l?.remote) out.push({ label: ctx.t(REMOTE_DISK), value: '—', level: 'none' });
  return out;
}
