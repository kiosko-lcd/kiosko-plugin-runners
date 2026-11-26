/**
 * When a cleanup timer last ran (Linux): `systemctl [--user] show` of the
 * timer, then of the service it starts. With `--timestamp=unix` (systemd
 * 248 and later) times come as `@1795661747`; older systemd writes
 * `Thu 2026-11-26 03:55:47 CET`, read here as the machine's local time.
 */
import type { TimerData } from '../../types.ts';
import type { Run } from '../../run.ts';

export const TIMER_PROPS = 'Id,LoadState,ActiveState,LastTriggerUSec,NextElapseUSecRealtime,Unit,Result';
export const SERVICE_PROPS = 'Id,LoadState,ActiveState,Result,ExecMainStatus,ExecMainExitTimestamp,ExecMainStartTimestamp';

/** `show`'s blocks (one per unit, separated by a blank line) as key → value. */
export function parseShow(text: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  let cur: Record<string, string> | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      if (cur) out.push(cur);
      cur = null;
      continue;
    }
    const i = line.indexOf('=');
    if (i <= 0) continue;
    (cur ??= {})[line.slice(0, i)] = line.slice(i + 1);
  }
  if (cur) out.push(cur);
  return out;
}

/** `@1795661747`, `Thu 2026-11-26 03:55:47 CET`, `n/a`, empty → epoch ms or null. */
export function parseTimestamp(v: string | undefined): number | null {
  if (!v) return null;
  const s = v.trim();
  const unix = /^@(\d+)(?:\.(\d+))?$/.exec(s);
  if (unix) return Number(unix[1]) * 1000;
  const m = /(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\s+(\S+))?/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, se, zone] = m;
  if (zone && /^(UTC|GMT|Z)$/i.test(zone)) return Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +se!);
  return new Date(+y!, +mo! - 1, +d!, +h!, +mi!, +se!).getTime();
}

/** `cleanup-runner-cache` → `cleanup-runner-cache.timer`. */
export const timerUnit = (name: string): string => (/\.(timer|service)$/.test(name) ? name : `${name}.timer`);

export function timerOf(unit: string, timer: Record<string, string> | undefined, service: Record<string, string> | undefined): TimerData {
  const found = !!timer && timer.LoadState !== 'not-found' && timer.LoadState !== undefined;
  const exit = service?.ExecMainStatus;
  return {
    unit,
    found,
    state: found ? (timer!.ActiveState ?? null) : null,
    lastAt: found ? (parseTimestamp(timer!.LastTriggerUSec) ?? parseTimestamp(service?.ExecMainStartTimestamp)) : null,
    nextAt: found ? parseTimestamp(timer!.NextElapseUSecRealtime) : null,
    result: service?.Result ?? (found ? (timer!.Result ?? null) : null),
    exitStatus: exit !== undefined && exit !== '' && Number.isFinite(Number(exit)) ? Number(exit) : null,
  };
}

/** Reads the timer and its service. Throws when `systemctl` isn't there. */
export async function readTimer(run: Run, name: string, scope: 'user' | 'system', o: { timeoutMs: number; signal?: AbortSignal }): Promise<TimerData> {
  const unit = timerUnit(name);
  const base = [...(scope === 'user' ? ['--user'] : []), 'show', '--no-pager'];
  const show = async (u: string, props: string) => {
    let r = await run('systemctl', [...base, '--timestamp=unix', '-p', props, u], o);
    // systemd before 248 doesn't know --timestamp.
    if (r.code !== 0 && /timestamp/i.test(r.stderr)) r = await run('systemctl', [...base, '-p', props, u], o);
    return parseShow(r.stdout)[0];
  };
  const timer = await show(unit, TIMER_PROPS);
  const svc = timer?.Unit || unit.replace(/\.timer$/, '.service');
  const service = timer && timer.LoadState !== 'not-found' && /\.service$/.test(svc) ? await show(svc, SERVICE_PROPS) : undefined;
  return timerOf(unit, timer, service);
}
