/**
 * `runners/now`: the runner right now. Whether its container is up (and
 * its version, how long it has been up), the jobs running on this machine
 * with their project, branch and time, the jobs waiting for a runner and
 * for how long, and what GitLab and GitHub say of their runners.
 */
import { defineWidget, type Graphics } from '@kiosko/sdk';
import { apiSummary, clamp, clipped, dataOf, drawLines, drawMessage, drawParts, fitSize, levelInk, MIN_PX, pendingParts, runnerParts, runningNow, runningText, jobsWord, SOURCE, worst, type Ctx, type Line, type Part } from './common.ts';
import { demoData } from './demo.ts';
import { L } from './i18n.ts';
import { JOBS, NOTHING, NOTHING_HOW, RUNNING, WAITING } from './labels.ts';
import type { RunnersData } from './types.ts';

/** The short form of a ref: `refs/merge-requests/173/head` → `!173`. */
export function shortRef(ref: string | null): string | null {
  if (!ref) return null;
  const mr = /^refs\/merge-requests\/(\d+)\//.exec(ref);
  if (mr) return `!${mr[1]}`;
  const pr = /^refs\/pull\/(\d+)\//.exec(ref);
  if (pr) return `#${pr[1]}`;
  return ref.replace(/^refs\/(heads|tags)\//, '');
}

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

/** The lines under the big number: the jobs, the waiting ones, the APIs, the metrics. */
export function detailLines(ctx: Ctx, d: RunnersData): Line[] {
  const c = ctx.theme.colors;
  const out: Line[] = [];
  for (const j of d.local?.jobs ?? []) {
    const parts: Part[] = [{ text: j.project ?? `#${j.id}`, color: c.ink }];
    const ref = shortRef(j.ref);
    if (ref) parts.push({ text: ref });
    if (j.startedAt) parts.push({ text: ctx.fmt.duration(Math.max(60_000, ctx.now - j.startedAt), { compact: true }) });
    out.push({ parts });
  }
  const pending = pendingParts(ctx, d);
  if (pending.length) out.push({ parts: pending });
  if (d.local) {
    for (const [n, a] of [['GitLab', d.gitlab], ['GitHub', d.github]] as const) if (a) out.push({ parts: apiSummary(ctx, n, a).parts });
  }
  return out;
}

function bigNumber(ctx: Ctx, d: RunnersData): { value: string; label: string } | null {
  const n = runningNow(d);
  if (n === null) return null;
  const max = d.metrics?.concurrent ?? d.local?.config?.concurrent ?? null;
  return { value: max ? `${n}/${max}` : String(n), label: `${ctx.t(JOBS)} ${ctx.t(RUNNING)}` };
}

function render(g: Graphics, ctx: Ctx): void {
  const d = dataOf(ctx.sources);
  if (!d) return drawMessage(g, ctx, ctx.t(WAITING));
  const head = headLine(ctx, d);
  if (!head) return drawMessage(g, ctx, ctx.t(NOTHING), ctx.t(NOTHING_HOW));
  const { box, kit, theme } = ctx;
  const c = theme.colors;
  const big = bigNumber(ctx, d);
  const rows = detailLines(ctx, d);

  // One line: ● Up · gitlab-runner · 2 jobs running · 3 pending.
  if (box.h < 60) {
    const s = clamp(Math.round(box.h * 0.42), MIN_PX, 22);
    const n = runningNow(d);
    const parts = [...head.parts.slice(0, 1), ...(n !== null ? [{ text: n === 0 ? runningText(ctx, 0) : `${n} ${jobsWord(ctx, n)}`, color: c.ink }] : []), ...pendingParts(ctx, d), ...head.parts.slice(1)];
    drawLines(g, ctx, [{ parts, ...(head.level ? { level: head.level } : {}) }], box.x, box.y + (box.h - s * 1.42) / 2, box.w, box.y + box.h, s);
    return;
  }

  const s = clamp(Math.round(Math.min(box.h * 0.1, box.w / 14)), MIN_PX, 22);
  // A wide strip: the big number on the left, the lines next to it in columns.
  if (box.w >= box.h * 3.2 && big) {
    const s = clamp(Math.round(box.h * 0.15), MIN_PX, 20);
    const bs = clamp(Math.round(box.h * 0.5), MIN_PX, 90);
    const label = { size: clamp(Math.round(bs * 0.28), MIN_PX, 20), family: theme.fonts.sans, color: c.inkDim };
    const bw = Math.max(kit.measureTracked(g, big.value, { size: bs, family: theme.fonts.sansBold }), kit.measureTracked(g, big.label, label));
    const top = box.y + (box.h - bs * 1.05 - label.size * 1.4) / 2;
    kit.drawTracked(g, big.value, box.x, top + bs * 0.88, { size: bs, family: theme.fonts.sansBold, color: levelInk(ctx, head.level ?? 'none') });
    kit.drawTracked(g, big.label, box.x, top + bs * 1.05 + label.size * 1.05, label);
    const x0 = box.x + bw + s * 1.6;
    const lines = [head, ...rows];
    const lh = s * 1.42;
    const per = Math.max(1, Math.floor(box.h / lh));
    const cols = Math.max(1, Math.min(Math.ceil(lines.length / per), Math.floor((box.x + box.w - x0) / (s * 14))));
    const colW = (box.x + box.w - x0) / cols;
    for (let i = 0; i < cols; i++) {
      const chunk = lines.slice(i * per, (i + 1) * per);
      drawLines(g, ctx, chunk, x0 + i * colW, box.y + (box.h - chunk.length * lh) / 2, colW - s, box.y + box.h, s);
    }
    return;
  }

  // Stacked: the runner line, the big number with its label, then the details.
  let y = drawLines(g, ctx, [head], box.x, box.y, box.w, box.y + box.h, s);
  if (big) {
    const room = box.y + box.h - y;
    const want = rows.length ? Math.min(room * 0.34, box.w / 3.2) : Math.min(room * 0.7, box.w / 2.6);
    const label = { size: clamp(Math.round(s * 0.95), MIN_PX, 20), family: theme.fonts.sans, color: c.inkDim };
    const lw = kit.measureTracked(g, big.label, label);
    const sideBySide = box.w - lw > want * 1.4;
    let bs = fitSize(g, ctx, big.value, box.w - (sideBySide ? lw + s : 0), clamp(Math.round(want), MIN_PX, 110));
    if (bs * 1.1 > room) bs = Math.max(MIN_PX, Math.floor(room / 1.1));
    if (room >= bs * 1.1 + (sideBySide ? 0 : label.size * 1.4)) {
      const base = y + bs * 0.95;
      const w = kit.drawTracked(g, big.value, box.x, base, { size: bs, family: theme.fonts.sansBold, color: c.ink });
      if (sideBySide) kit.drawTracked(g, big.label, box.x + w + s * 0.6, base, label);
      y += bs * 1.12;
      if (!sideBySide) {
        drawParts(g, ctx, [{ text: big.label }], box.x, y + label.size, box.w, label.size);
        y += label.size * 1.4;
      }
      y += s * 0.3;
    }
  }
  drawLines(g, ctx, rows, box.x, y, box.w, box.y + box.h, s);
}

export const now = defineWidget({
  id: 'now',
  name: L('Runners now', 'Runners ahora', 'Runner jetzt', 'Runner 现状', 'Runner 現況'),
  description: L(
    'Whether the runner container is up, its version and how long it has run; the jobs running on this machine (project, branch, time); the jobs waiting for a runner and the oldest wait; and what GitLab and GitHub say of their runners.',
    'Si el contenedor del runner está en marcha, su versión y desde cuándo; los trabajos que corren en este equipo (proyecto, rama, tiempo); los que esperan runner y la espera más larga; y lo que GitLab y GitHub dicen de sus runners.',
    'Ob der Runner-Container läuft, seine Version und wie lange schon; die Jobs auf diesem Rechner (Projekt, Branch, Zeit); die auf einen Runner wartenden Jobs und die längste Wartezeit; und was GitLab und GitHub über ihre Runner sagen.',
    'Runner 容器是否在运行、版本及已运行时长；本机上运行中的作业（项目、分支、时长）；等待 Runner 的作业及最长等待；以及 GitLab 和 GitHub 上各 Runner 的状态。',
    'Runner 容器是否在執行、版本及已執行時長；本機上執行中的作業（專案、分支、時長）；等待 Runner 的作業及最長等待；以及 GitLab 和 GitHub 上各 Runner 的狀態。',
  ),
  icon: 'server',
  category: 'dev',
  tags: ['ci', 'gitlab-runner', 'github-actions', 'docker', 'jobs'],
  size: { min: { w: 160, h: 30 }, preferred: { w: 320, h: 200 } },
  sources: [SOURCE],
  redraw: 'minute',
  render(g, ctx) {
    clipped(g, ctx, () => render(g, ctx));
  },
  demo: ({ now: at }) => ({ sources: { [SOURCE]: demoData(at) } }),
});
