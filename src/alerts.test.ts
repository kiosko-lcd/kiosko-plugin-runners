import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttp, localize, validate } from '@kiosko/sdk';
import { sourceAlerts } from '@kiosko/sdk/testing';
import { runnerAlerts } from './alerts.ts';
import { demoData } from './demo.ts';
import { fixtureText } from './fixtures.ts';
import { Monitor, type MonitorOptions } from './monitor.ts';
import type { Saved } from './providers/local/index.ts';
import { guard, type Run } from './run.ts';
import { runnersSource, sourceOptions } from './source.ts';
import type { RunnersData } from './types.ts';

const NOW = Date.parse('2026-11-26T20:10:00Z');
const MIN = 60_000;
const H = 60 * MIN;
const GB = 1e9;

const ids = (a: { id: string }[]) => a.map((x) => x.id.replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{10,}$/, ''));
const opts = (o: Record<string, unknown> = {}) => validate(sourceOptions, o).value as unknown as MonitorOptions;

/** A machine whose runner state, disk and timer the test changes as the fake clock runs. */
function machine() {
  const st = { runner: 'running', status: 'Up 10 days', freeGb: 48.3, growGbPerMeasure: 0.25, df: 0, lastTimer: Math.floor((NOW - 16 * H) / 1000), result: 'success' };
  let saved: Saved = {};
  const run: Run = async (cmd, args) => {
    const a = args.join(' ');
    if (cmd === 'systemctl') {
      const unit = args[args.length - 1]!;
      if (unit.endsWith('.timer')) return { stdout: `Id=${unit}\nLoadState=loaded\nActiveState=active\nLastTriggerUSec=@${st.lastTimer}\nUnit=cleanup.service\nResult=success\n`, stderr: '', code: 0 };
      return { stdout: `Id=cleanup.service\nLoadState=loaded\nResult=${st.result}\nExecMainStatus=${st.result === 'success' ? 0 : 1}\n`, stderr: '', code: 0 };
    }
    if (a.startsWith('ps')) {
      const row = JSON.parse(fixtureText('docker-ps.jsonl').split('\n')[0]!);
      return { stdout: JSON.stringify({ ...row, State: st.runner, Status: st.status }), stderr: '', code: 0 };
    }
    if (a.startsWith('info')) return { stdout: fixtureText('docker-info-rootless.json'), stderr: '', code: 0 };
    if (a.startsWith('volume ls')) return { stdout: fixtureText('docker-volume-ls.jsonl'), stderr: '', code: 0 };
    if (a.startsWith('system df')) {
      st.df++;
      return { stdout: fixtureText('docker-system-df-v.json').replace('"2.1GB"', `"${(2.1 + st.df * st.growGbPerMeasure).toFixed(2)}GB"`), stderr: '', code: 0 };
    }
    throw new Error(a);
  };
  const m = (start: number) =>
    new Monitor(
      {
        local: {
          run: guard(run),
          os: 'linux',
          env: { DOCKER_HOST: 'unix:///run/user/1000/docker.sock' },
          exists: () => false,
          statfs: async () => ({ bsize: 1000, blocks: 243.8e6, bavail: st.freeGb * 1e6 }),
          readFile: async () => '',
          store: { load: async () => saved, save: async (s) => void (saved = s) },
        },
        http: createHttp({ fetch: (async () => new Response('[]')) as typeof fetch }),
      },
      start,
    );
  return { st, m };
}

async function runFor(mon: Monitor, o: MonitorOptions, from: number, to: number, step = 30_000): Promise<RunnersData> {
  let d!: RunnersData;
  for (let at = from; at <= to; at += step) {
    d = await mon.sample(o, at, undefined, () => at);
    await mon.idle();
  }
  return d;
}

test('a healthy machine: no alerts; the demo neither', async () => {
  const { m } = machine();
  const o = opts({ cleanupTimer: 'cleanup' });
  const d = await runFor(m(NOW), o, NOW, NOW + 3 * H);
  assert.deepEqual(runnerAlerts(d, NOW + 3 * H), []);
  // 0.25 GB per 30 min: 12 GB a day, under the 20 GB default.
  assert.ok(Math.abs(d.local!.growth.perDay! - 12 * GB) < 0.1 * GB);
  assert.deepEqual(sourceAlerts(runnersSource, { now: NOW }).map((a) => a.id).filter((x) => !x.startsWith('pending') && !x.startsWith('offline') && !x.startsWith('growth')), []);
});

test('runner down is critical, restarting a warning; one alert per episode', async () => {
  const { st, m } = machine();
  const mon = m(NOW);
  const o = opts();
  let d = await runFor(mon, o, NOW, NOW + MIN);
  st.runner = 'restarting';
  st.status = 'Restarting (1) 5 seconds ago';
  d = await runFor(mon, o, NOW + 2 * MIN, NOW + 3 * MIN);
  let a = runnerAlerts(d, NOW + 3 * MIN);
  assert.deepEqual(a.map((x) => [x.level, localize(x.title, 'en')]), [['warn', 'The runner keeps restarting']]);
  st.runner = 'exited';
  st.status = 'Exited (137) 1 minute ago';
  d = await runFor(mon, o, NOW + 4 * MIN, NOW + 5 * MIN);
  a = runnerAlerts(d, NOW + 5 * MIN);
  assert.deepEqual(a.map((x) => [x.level, localize(x.title, 'es')]), [['critical', 'El runner está parado']]);
  const id = a[0]!.id;
  d = await runFor(mon, o, NOW + 6 * MIN, NOW + 9 * MIN);
  assert.equal(runnerAlerts(d, NOW + 9 * MIN)[0]!.id, id, 'the same episode keeps its id');
  assert.match(localize(a[0]!.text!, 'en'), /gitlab-runner · Exited \(137\)/);
});

test('disk under 15 % free is critical, with when it is full at the current growth', async () => {
  const { st, m } = machine();
  st.freeGb = 30;
  st.growGbPerMeasure = 1;
  const d = await runFor(m(NOW), opts(), NOW, NOW + 4 * H);
  const a = runnerAlerts(d, NOW + 4 * H);
  // 30 / 243.8 = 12 %; 1 GB per 30 min = 48 GB a day: full in 15 hours. Also growing over 20 GB a day.
  assert.deepEqual(ids(a), ['disk-/home/u/.local/share/docker', 'growth']);
  assert.equal(a[0]!.level, 'critical');
  assert.equal(localize(a[0]!.text!, 'en'), 'Free: 30 GB (12%) · full in 15 h');
  assert.match(localize(a[0]!.text!, 'es'), /^Libre: 30 GB \(12\s%\) · lleno en 15 h$/);
  assert.equal(localize(a[1]!.text!, 'de'), '+48 GB/Tag · Grenze +20 GB/Tag');
  // A higher limit: no growth alert.
  const d2 = await runFor(m(NOW), opts({ growthMaxGb: 100, diskFreeMinPct: 10 }), NOW, NOW + 4 * H);
  assert.deepEqual(runnerAlerts(d2, NOW + 4 * H), []);
});

test('cleanup timer: fine for 26 h, then a warning; a failed run warns at once', async () => {
  const { st, m } = machine();
  const mon = m(NOW);
  const o = opts({ cleanupTimer: 'cleanup' });
  let d = await runFor(mon, o, NOW, NOW + 9 * H, 5 * MIN);
  // Last run at NOW-16h: at NOW+9h it is 25 h ago.
  assert.deepEqual(runnerAlerts(d, NOW + 9 * H), []);
  d = await runFor(mon, o, NOW + 9 * H + 5 * MIN, NOW + 11 * H, 5 * MIN);
  const a = runnerAlerts(d, NOW + 11 * H);
  assert.deepEqual(a.map((x) => localize(x.title, 'en')), ['The cache cleanup has not run']);
  assert.equal(localize(a[0]!.text!, 'en'), 'cleanup.timer · last run 27 h ago');
  st.lastTimer = Math.floor((NOW + 11 * H) / 1000);
  st.result = 'exit-code';
  d = await runFor(mon, o, NOW + 11 * H + 5 * MIN, NOW + 11 * H + 10 * MIN, 5 * MIN);
  assert.deepEqual(runnerAlerts(d, NOW + 11 * H + 10 * MIN).map((x) => localize(x.title, 'de')), ['Die Cache-Bereinigung ist fehlgeschlagen']);
});

test('a job waiting longer than 15 minutes, and a runner the API sees offline', () => {
  const d = demoData(NOW);
  const t = d.gitlab!.oldestPendingAt!;
  const at = (ms: number) => runnerAlerts({ ...d, local: null, github: null }, t + ms);
  assert.deepEqual(ids(at(14 * MIN)).filter((x) => x.startsWith('pending')), []);
  const a = at(16 * MIN);
  assert.deepEqual(ids(a), ['pending-GitLab', 'offline-GitLab-38']);
  assert.equal(localize(a[0]!.text!, 'en'), 'GitLab · 3 waiting · the oldest for 16 min');
  assert.equal(localize(a[0]!.text!, 'zh-Hans'), 'GitLab · 3 个排队 · 最久已等 16 分钟');
});

test('alerts off: nothing; Docker not answering: critical', () => {
  const d = demoData(NOW);
  assert.deepEqual(runnerAlerts({ ...d, alerts: { enabled: false } }, NOW), []);
  const down: RunnersData = { ...d, gitlab: null, github: null, local: { ...d.local!, error: 'not-running', runners: [] } };
  const a = runnerAlerts(down, NOW);
  assert.equal(a[0]!.level, 'critical');
  assert.equal(localize(a[0]!.title, 'en'), 'Docker is not answering');
});
