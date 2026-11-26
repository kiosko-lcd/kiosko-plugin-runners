/**
 * gitlab-runner's own Prometheus metrics, when `listen_address` is set in
 * its config.toml (`listen_address = ":9252"`): `GET /metrics`, the
 * Prometheus text format. Read here:
 *
 * - `gitlab_runner_version_info{version="…"} 1`
 * - `gitlab_runner_concurrent` — the `concurrent` setting
 * - `gitlab_runner_jobs{state="running",…}` — jobs now, summed
 * - `gitlab_runner_jobs_total`, `gitlab_runner_failed_jobs_total`
 * - `gitlab_runner_errors_total{level="error"}` (also `fatal`, `panic`)
 * - `process_start_time_seconds`
 *
 * No token: the endpoint has none. Its address is in the options, or comes
 * from config.toml when that's set.
 */
import { L } from '../i18n.ts';
import type { MetricsData } from '../types.ts';
import { errorWord, type RemoteContext, type RemoteOptions, type RemoteProvider } from './provider.ts';

export interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** The Prometheus text format: `name{k="v",…} value [timestamp]`; comments and broken lines skipped. */
export function parseProm(text: string): Sample[] {
  const out: Sample[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})?\s+(\S+)/.exec(line);
    if (!m) continue;
    const labels: Record<string, string> = {};
    if (m[3]) for (const l of m[3].matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) labels[l[1]!] = l[2]!.replace(/\\(.)/g, '$1');
    const v = m[4] === '+Inf' ? Infinity : m[4] === '-Inf' ? -Infinity : Number(m[4]);
    if (Number.isNaN(v)) continue;
    out.push({ name: m[1]!, labels, value: v });
  }
  return out;
}

const sum = (xs: Sample[], name: string, where: (l: Record<string, string>) => boolean = () => true): number | null => {
  const v = xs.filter((s) => s.name === name && where(s.labels));
  return v.length ? v.reduce((a, s) => a + s.value, 0) : null;
};

export function metricsOf(text: string, at: number): MetricsData {
  const xs = parseProm(text);
  if (!xs.some((s) => s.name.startsWith('gitlab_runner_'))) throw new Error('not gitlab-runner metrics');
  const start = sum(xs, 'process_start_time_seconds');
  return {
    at,
    version: xs.find((s) => s.name === 'gitlab_runner_version_info')?.labels.version ?? null,
    concurrent: sum(xs, 'gitlab_runner_concurrent'),
    running: sum(xs, 'gitlab_runner_jobs', (l) => !l.state || l.state === 'running') ?? 0,
    jobsTotal: sum(xs, 'gitlab_runner_jobs_total'),
    failedTotal: sum(xs, 'gitlab_runner_failed_jobs_total'),
    errorsTotal: sum(xs, 'gitlab_runner_errors_total', (l) => !l.level || l.level === 'error' || l.level === 'fatal' || l.level === 'panic'),
    startedAt: start !== null ? Math.round(start * 1000) : null,
  };
}

export const metricsUrl = (o: RemoteOptions, fallback?: string | null): string => o.metricsUrl.trim() || fallback || '';

export async function readMetrics(o: RemoteOptions, ctx: RemoteContext): Promise<MetricsData> {
  try {
    const r = await ctx.http.text(metricsUrl(o, ctx.metricsFallback), { ...(ctx.signal ? { signal: ctx.signal } : {}), noCache: true });
    return metricsOf(r.data, ctx.now);
  } catch (e) {
    const word = (e as Error).message === 'not gitlab-runner metrics' ? 'not gitlab-runner metrics' : errorWord(e);
    ctx.log?.(`runners: metrics: ${word}`);
    return { at: ctx.now, error: word, version: null, concurrent: null, running: 0, jobsTotal: null, failedTotal: null, errorsTotal: null, startedAt: null };
  }
}

export const metrics: RemoteProvider<MetricsData> = {
  id: 'metrics',
  name: L('Runner metrics', 'Métricas del runner', 'Runner-Metriken', 'Runner 指标', 'Runner 指標'),
  hosts: [],
  enabled: (o, ctx) => !!metricsUrl(o, ctx.metricsFallback),
  everyMs: 60_000,
  read: readMetrics,
};
