/**
 * Sample data for the gallery, the editor and the tests: a GitLab runner in
 * rootless Docker on a desktop, two jobs running, its cache volumes back
 * to 29 GB since the nightly cleanup at 03:55 and growing some 36 GB a
 * day, 48 GB left on the disk; GitLab sees two runners (one offline) and
 * three jobs waiting, GitHub one idle self-hosted runner. Deterministic:
 * the same `now` paints the same picture.
 */
import { fullInDays, growthOf } from './history.ts';
import type { ApiData, LocalData, RunnersData, SizePoint, Thresholds } from './types.ts';

export const DEMO_THRESHOLDS: Thresholds = { diskFreeMin: 0.15, growthMax: 20e9, pendingMaxMs: 15 * 60_000, timerMaxMs: 26 * 3_600_000 };

const GB = 1e9;
const H = 3_600_000;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every 30 min for 26 h: growing, a cleanup 16 h 15 min ago, growing again. */
export function demoHistory(now: number): SizePoint[] {
  const r = rng(7);
  const step = 30 * 60_000;
  const end = Math.floor(now / step) * step;
  const cleanAt = now - 16 * H - 15 * 60_000;
  const out: SizePoint[] = [];
  for (let at = end - 26 * H; at <= end; at += step) {
    const since = at >= cleanAt ? at - cleanAt : at - (cleanAt - 24 * H);
    // Busier in working hours: most of the growth between 8 and 20 h after the cleanup.
    const hours = since / H;
    const work = Math.max(0, Math.min(hours, 16.25) - 4) * 2.05 + Math.max(0, hours - 16.25) * 0.4;
    out.push({ at, bytes: Math.round((3.1 + work + r() * 0.35) * GB) });
  }
  return out;
}

export function demoLocal(now: number): LocalData {
  const history = demoHistory(now);
  const growth = growthOf(history, now);
  const total = history[history.length - 1]!.bytes;
  const cache = Math.round(total * 0.236);
  const prot = Math.round(total * 0.74);
  const disk = { path: '/home/runner/.local/share/docker', totalBytes: 243.8 * GB, freeBytes: 48.3 * GB, freeShare: 48.3 / 243.8 };
  return {
    engine: 'docker',
    rootless: true,
    remote: false,
    serverVersion: '29.1.3',
    rootDir: disk.path,
    runners: [{ name: 'gitlab-runner', image: 'gitlab/gitlab-runner:v19.5.1', version: '19.5.1', state: 'running', health: null, createdAt: now - 22 * 24 * H, startedAt: now - 10 * 24 * H - 3 * H, status: 'Up 10 days' }],
    jobs: [
      { id: '4211', project: 'web', ref: 'main', kind: 'build', startedAt: now - 4 * 60_000 - 20_000 },
      { id: '4214', project: 'api', ref: 'refs/merge-requests/173/head', kind: 'build', startedAt: now - 70_000 },
    ],
    sizes: {
      at: now - 12 * 60_000,
      tookMs: 14_200,
      total: { count: 62, bytes: total },
      cache: { count: 32, bytes: cache },
      builds: { count: 30, bytes: total - cache },
      protected: { count: 42, bytes: prot },
      unprotected: { count: 20, bytes: total - prot },
      other: { count: 17, bytes: 4.2 * GB },
      largest: 2.9 * GB,
    },
    measuring: false,
    nextSizesAt: now + 18 * 60_000,
    history: history.filter((p) => p.at >= now - 24 * H),
    growth,
    disk,
    fullInDays: fullInDays(disk.freeBytes, growth.perDay),
    timer: { unit: 'cleanup-runner-cache.timer', found: true, state: 'active', lastAt: now - 16 * H - 15 * 60_000, nextAt: now + 7 * H + 45 * 60_000, result: 'success', exitStatus: 0 },
    config: null,
  };
}

export function demoGitlab(now: number): ApiData {
  return {
    at: now - 40_000,
    runners: [
      { id: '41', name: 'desktop · docker', status: 'online', busy: true, contactedAt: now - 20_000, version: '19.5.1', labels: ['docker', 'linux'] },
      { id: '38', name: 'old laptop', status: 'offline', busy: false, contactedAt: now - 3 * 24 * H, version: '18.2.0', labels: [] },
    ],
    pending: 3,
    running: 2,
    oldestPendingAt: now - 9 * 60_000,
    jobs: [
      { id: '4211', project: 'web', name: 'test', status: 'running', createdAt: now - 6 * 60_000, startedAt: now - 4 * 60_000 },
      { id: '4214', project: 'api', name: 'build', status: 'running', createdAt: now - 2 * 60_000, startedAt: now - 70_000 },
      { id: '4215', project: 'api', name: 'lint', status: 'pending', createdAt: now - 9 * 60_000, startedAt: null },
      { id: '4216', project: 'api', name: 'e2e', status: 'pending', createdAt: now - 2 * 60_000, startedAt: null },
      { id: '4217', project: 'docs', name: 'pages', status: 'pending', createdAt: now - 60_000, startedAt: null },
    ],
  };
}

export function demoGithub(now: number): ApiData {
  return {
    at: now - 70_000,
    runners: [{ id: '7', name: 'build-box', status: 'online', busy: false, contactedAt: null, version: null, labels: ['gpu', 'self-hosted', 'Linux', 'X64'] }],
    pending: 0,
    running: 0,
    oldestPendingAt: null,
    jobs: [],
  };
}

export function demoData(now: number): RunnersData {
  return {
    at: now,
    local: demoLocal(now),
    gitlab: demoGitlab(now),
    github: demoGithub(now),
    metrics: { at: now - 30_000, version: '19.5.1', concurrent: 4, running: 2, jobsTotal: 1840, failedTotal: 61, errorsTotal: 3, startedAt: now - 10 * 24 * H - 3 * H },
    thresholds: DEMO_THRESHOLDS,
    alerts: { enabled: true },
    demo: true,
  };
}
