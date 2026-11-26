/**
 * The monitor behind the `runners/runners` source: one per data folder.
 * Every read asks the local provider (Docker or Podman on this machine)
 * and starts, without waiting, the remote ones that are due (GitLab's API,
 * GitHub's, the runner's metrics): the next read shows what they said.
 *
 * Time is the read's `now` and everything it touches comes in `deps`, so
 * the tests drive it with a fake clock and fake commands.
 */
import type { HttpClient } from '@kiosko/sdk';
import { LocalReader, type LocalDeps, type LocalOptions } from './providers/local/index.ts';
import { metricsUrlOf } from './providers/local/configtoml.ts';
import { REMOTE, type RemoteId } from './providers/index.ts';
import type { RemoteOptions } from './providers/provider.ts';
import type { ApiData, MetricsData, RunnersData, Thresholds } from './types.ts';

export interface MonitorOptions extends LocalOptions, RemoteOptions {
  alerts: boolean;
  diskFreeMinPct: number;
  growthMaxGb: number;
  pendingMaxMs: number;
  timerMaxMs: number;
}

export interface MonitorDeps {
  local: LocalDeps;
  http: HttpClient;
  log?: (m: string) => void;
}

export function thresholdsOf(o: Pick<MonitorOptions, 'diskFreeMinPct' | 'growthMaxGb' | 'pendingMaxMs' | 'timerMaxMs'>): Thresholds {
  return { diskFreeMin: o.diskFreeMinPct / 100, growthMax: o.growthMaxGb * 1e9, pendingMaxMs: o.pendingMaxMs, timerMaxMs: o.timerMaxMs };
}

interface Remote {
  key: string;
  at: number;
  data: ApiData | MetricsData | null;
  running: boolean;
}

export class Monitor {
  private deps: MonitorDeps;
  private local: LocalReader;
  private remote = new Map<RemoteId, Remote>();
  private inflight = new Set<Promise<unknown>>();

  constructor(deps: MonitorDeps, startedAt: number) {
    this.deps = deps;
    this.local = new LocalReader(deps.local, startedAt);
  }

  async idle(): Promise<void> {
    await this.local.idle();
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
    await this.local.idle();
  }

  private remoteData(id: RemoteId, o: MonitorOptions, now: number, fallback: string | null): ApiData | MetricsData | null {
    const p = REMOTE[id];
    const key = JSON.stringify([id, o.gitlabUrl, o.gitlabToken, o.gitlabProjects, o.gitlabGroups, o.githubApi, o.githubToken, o.githubRepos, o.githubOrgs, o.metricsUrl, fallback]);
    if (!p.enabled(o, { metricsFallback: fallback })) {
      this.remote.delete(id);
      return null;
    }
    let r = this.remote.get(id);
    if (!r || r.key !== key) this.remote.set(id, (r = { key, at: -Infinity, data: null, running: false }));
    if (!r.running && now - r.at >= p.everyMs) {
      r.running = true;
      r.at = now;
      const cur = r;
      const q = (p.read as (o: RemoteOptions, c: object) => Promise<ApiData | MetricsData>)(o, { http: this.deps.http, now, metricsFallback: fallback, ...(this.deps.log ? { log: this.deps.log } : {}) })
        .then((d) => void (cur.data = d))
        .catch(() => {})
        .finally(() => {
          cur.running = false;
          this.inflight.delete(q);
        });
      this.inflight.add(q);
    }
    return r.data;
  }

  async sample(o: MonitorOptions, now: number, signal?: AbortSignal, clock?: () => number): Promise<RunnersData> {
    const local = o.engine === 'off' ? null : await this.local.read(o, now, signal, clock);
    const listen = local?.config?.listenAddress;
    const fallback = listen ? metricsUrlOf(listen) : null;
    return {
      at: now,
      local,
      gitlab: this.remoteData('gitlab', o, now, fallback) as ApiData | null,
      github: this.remoteData('github', o, now, fallback) as ApiData | null,
      metrics: this.remoteData('metrics', o, now, fallback) as MetricsData | null,
      thresholds: thresholdsOf(o),
      alerts: { enabled: o.alerts },
    };
  }
}
