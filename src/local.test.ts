import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureText } from './fixtures.ts';
import { cleanUrl, metricsUrlOf, parseConfigToml } from './providers/local/configtoml.ts';
import { dockerEnv, isRemote, LocalReader, type LocalDeps, type LocalOptions, type Saved } from './providers/local/index.ts';
import { uptimeOf, healthOf, jobsOf, kindOf, parseCreated, parseInfo, parseLabels, parsePs, parseSize, parseSystemDfJson, parseSystemDfTable, parseVolumes, problemOf, runnersOf, summarizeVolumes, versionOfImage, BUILDS_HASH, CACHE_HASH } from './providers/local/parse.ts';
import { parseShow, parseTimestamp, readTimer, timerOf } from './providers/local/systemd.ts';
import { guard, isReadOnly, type Run } from './run.ts';

const GB = 1e9;

test('sizes as Docker and Podman write them', () => {
  assert.equal(parseSize('561.2MB'), 561_200_000);
  assert.equal(parseSize('2.1GB'), 2_100_000_000);
  assert.equal(parseSize('0B'), 0);
  assert.equal(parseSize('23.67MB'), 23_670_000);
  assert.equal(parseSize('1.5 GB'), 1_500_000_000);
  assert.equal(parseSize('3GiB'), 3 * 1024 ** 3);
  assert.equal(parseSize('120kB'), 120_000);
  assert.equal(parseSize('N/A'), null);
  assert.equal(parseSize(''), null);
});

test('labels: Docker’s string (values with commas and equals) and Podman’s object', () => {
  assert.deepEqual(parseLabels('a=1,b=x,y,c=k=v'), { a: '1', b: 'x,y', c: 'k=v' });
  assert.deepEqual(parseLabels('com.docker.volume.anonymous='), { 'com.docker.volume.anonymous': '' });
  assert.deepEqual(parseLabels({ x: 'y' }), { x: 'y' });
  assert.deepEqual(parseLabels(null), {});
});

test('dates of ps: Docker’s written form, Podman’s epoch seconds', () => {
  assert.equal(parseCreated('2026-11-16 10:32:09 +0100 CET'), Date.parse('2026-11-16T09:32:09Z'));
  assert.equal(parseCreated(1795247529), 1795247529000);
  assert.equal(parseCreated('10 days ago'), null);
});

test('docker ps: the runner container, and one job per id from its build and service containers (helpers and finished jobs left out)', () => {
  const cs = parsePs(fixtureText('docker-ps.jsonl'));
  assert.equal(cs.length, 7);
  const runners = runnersOf(cs);
  assert.deepEqual(runners.map((r) => [r.name, r.version, r.state, r.health]), [['gitlab-runner', '19.5.1', 'running', null]]);
  assert.equal(runners[0]!.status, 'Up 10 days');
  assert.equal(uptimeOf('Up 10 days'), 10 * 86_400_000);
  assert.equal(uptimeOf('Up About an hour (healthy)'), 3_600_000);
  assert.equal(uptimeOf('Up Less than a second'), 0);
  assert.equal(uptimeOf('Exited (0) 2 hours ago'), null);
  assert.equal(runnersOf(cs, '', 1_000_000_000_000)[0]!.startedAt, 1_000_000_000_000 - 10 * 86_400_000);
  assert.equal(runnersOf(parsePs(fixtureText('podman-ps.json')))[0]!.startedAt, 1795247530000);
  const jobs = jobsOf(cs);
  assert.deepEqual(jobs.map((j) => [j.id, j.project, j.ref, j.kind]), [['4211', 'web', 'main', 'build'], ['4214', 'api', 'refs/merge-requests/173/head', 'build']]);
  // The job started when its first container (the service) was created.
  assert.equal(jobs[0]!.startedAt, Date.parse('2026-11-26T20:05:20Z'));
  assert.deepEqual(runnersOf(cs, 'proxy').map((r) => [r.name, r.health]), [['proxy', 'healthy']]);
});

test('podman ps: the same from its JSON array, labels as an object', () => {
  const cs = parsePs(fixtureText('podman-ps.json'));
  assert.deepEqual(runnersOf(cs).map((r) => [r.name, r.version, r.state]), [['gitlab-runner', '18.6.2', 'running']]);
  assert.deepEqual(jobsOf(cs).map((j) => [j.project, j.ref]), [['data-pipeline', 'v2.1.0']]);
});

test('a runner restarting, and the words of old Docker without State', () => {
  const [c] = parsePs(fixtureText('docker-ps-restarting.jsonl'));
  assert.equal(c!.state, 'restarting');
  assert.equal(parsePs('{"Names":"x","Image":"y","Status":"Exited (1) 2 hours ago"}')[0]!.state, 'exited');
  assert.equal(healthOf('Up 3 hours (unhealthy)'), 'unhealthy');
  assert.equal(versionOfImage('gitlab/gitlab-runner:latest'), null);
  assert.equal(versionOfImage('registry.example.com:5000/gitlab/gitlab-runner:alpine-v17.4.0'), '17.4.0');
});

test('volume kinds: from labels, else from the md5 in the name', () => {
  assert.deepEqual(kindOf(`runner-ab12-cache-${CACHE_HASH}-protected`), { kind: 'cache', protected: true });
  assert.deepEqual(kindOf(`runner-ab12-cache-${BUILDS_HASH}`), { kind: 'builds', protected: false });
  assert.deepEqual(kindOf('pgdata'), { kind: 'other', protected: false });
  assert.deepEqual(kindOf('anything', { 'com.gitlab.gitlab-runner.managed': 'true', 'com.gitlab.gitlab-runner.destination': '/cache', 'com.gitlab.gitlab-runner.protected': 'false' }), { kind: 'cache', protected: false });
});

const expectSplit = (s: ReturnType<typeof summarizeVolumes>) => {
  assert.equal(s.total.count, 6);
  assert.equal(s.total.bytes, 561.2e6 + 2.1e9 + 120e6 + 890.5e6 + 0 + 1.25e9);
  assert.deepEqual(s.cache, { count: 3, bytes: 561.2e6 + 120e6 });
  assert.deepEqual(s.builds, { count: 3, bytes: 2.1e9 + 890.5e6 + 1.25e9 });
  assert.deepEqual(s.protected, { count: 4, bytes: 561.2e6 + 2.1e9 + 1.25e9 });
  assert.deepEqual(s.unprotected, { count: 2, bytes: 120e6 + 890.5e6 });
  assert.deepEqual(s.other, { count: 2, bytes: 4.2e9 + 23.67e6 });
  assert.equal(s.largest, 2.1e9);
};

test('system df -v: Docker’s JSON (labels in it) and its table (labels from volume ls) add up the same', () => {
  const json = parseSystemDfJson(fixtureText('docker-system-df-v.json'))!;
  expectSplit(summarizeVolumes(json, [], 1, 2));
  const table = parseSystemDfTable(fixtureText('docker-system-df-v.txt'))!;
  assert.equal(table.length, 8);
  expectSplit(summarizeVolumes(table, parseVolumes(fixtureText('docker-volume-ls.jsonl')), 1, 2));
  // The table alone: the kinds from the names.
  expectSplit(summarizeVolumes(table, [], 1, 2));
  assert.equal(parseSystemDfJson(fixtureText('docker-system-df-v.txt')), null);
});

test('podman system df -v and volume ls', () => {
  const s = summarizeVolumes(parseSystemDfTable(fixtureText('podman-system-df-v.txt'))!, parseVolumes(fixtureText('podman-volume-ls.json')), 1, 2);
  assert.deepEqual([s.total, s.cache, s.builds, s.protected, s.other], [{ count: 2, bytes: 4.75 * GB }, { count: 1, bytes: 1.5 * GB }, { count: 1, bytes: 3.25 * GB }, { count: 1, bytes: 3.25 * GB }, { count: 1, bytes: 312e6 }]);
});

test('info: rootless and rootful Docker, Podman, and a daemon that is down', () => {
  assert.deepEqual(parseInfo(fixtureText('docker-info-rootless.json')), { serverVersion: '29.1.3', rootDir: '/home/u/.local/share/docker', rootless: true });
  assert.deepEqual(parseInfo(fixtureText('docker-info-rootful.json')), { serverVersion: '29.1.3', rootDir: '/var/lib/docker', rootless: false });
  assert.deepEqual(parseInfo(fixtureText('podman-info.json')), { serverVersion: '5.6.1', rootDir: '/home/u/.local/share/containers/storage/volumes', rootless: true });
  assert.match(parseInfo(fixtureText('docker-info-down.json')).error!, /Cannot connect/);
  assert.equal(problemOf('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'), 'not-running');
  assert.equal(problemOf('permission denied while trying to connect to the Docker daemon socket'), 'permission');
});

test('DOCKER_HOST: the option, the environment, or the rootless socket when there is no system one', () => {
  const none = () => false;
  assert.equal(dockerEnv({ dockerHost: 'tcp://10.0.0.5:2376' }, { os: 'linux', env: {}, exists: none }).env.DOCKER_HOST, 'tcp://10.0.0.5:2376');
  assert.deepEqual(dockerEnv({ dockerHost: '' }, { os: 'linux', env: { DOCKER_HOST: 'unix:///run/user/1000/docker.sock' }, exists: none }), { env: {}, host: 'unix:///run/user/1000/docker.sock', rootlessSocket: true });
  const rootless = dockerEnv({ dockerHost: '' }, { os: 'linux', env: { XDG_RUNTIME_DIR: '/run/user/1000' }, exists: (p) => p === '/run/user/1000/docker.sock' });
  assert.deepEqual(rootless, { env: { DOCKER_HOST: 'unix:///run/user/1000/docker.sock' }, host: 'unix:///run/user/1000/docker.sock', rootlessSocket: true });
  // With the system socket there, Docker's own default is left alone.
  assert.deepEqual(dockerEnv({ dockerHost: '' }, { os: 'linux', env: { XDG_RUNTIME_DIR: '/run/user/1000' }, exists: () => true }).env, {});
  assert.equal(isRemote('tcp://10.0.0.5:2376', 'linux'), true);
  assert.equal(isRemote('unix:///run/user/1000/docker.sock', 'linux'), false);
  assert.equal(isRemote(null, 'darwin'), true);
});

test('systemctl show: unix timestamps, the written form, a unit that is not there', () => {
  const [t] = parseShow(fixtureText('systemctl-show-unix.txt'));
  const [s] = parseShow(fixtureText('systemctl-show-service.txt'));
  assert.deepEqual(timerOf('cleanup-runner-cache.timer', t, s), { unit: 'cleanup-runner-cache.timer', found: true, state: 'active', lastAt: 1795661747000, nextAt: 1795747720000, result: 'success', exitStatus: 0 });
  const [legacy] = parseShow(fixtureText('systemctl-show-legacy.txt'));
  assert.equal(timerOf('x', legacy, undefined).lastAt, Date.UTC(2026, 10, 26, 2, 55, 47));
  const [missing] = parseShow(fixtureText('systemctl-show-notfound.txt'));
  assert.deepEqual(timerOf('no-such.timer', missing, undefined), { unit: 'no-such.timer', found: false, state: null, lastAt: null, nextAt: null, result: null, exitStatus: null });
  assert.equal(parseTimestamp('n/a'), null);
  assert.equal(parseTimestamp(''), null);
});

test('readTimer asks only read-only questions, and falls back for systemd without --timestamp', async () => {
  const calls: string[][] = [];
  const run: Run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    assert.ok(isReadOnly(cmd, args), args.join(' '));
    if (args.includes('--timestamp=unix')) return { stdout: '', stderr: 'Unknown option --timestamp', code: 1 };
    const unit = args[args.length - 1]!;
    return { stdout: fixtureText(unit.endsWith('.timer') ? 'systemctl-show-legacy.txt' : 'systemctl-show-service-failed.txt'), stderr: '', code: 0 };
  };
  const t = await readTimer(guard(run), 'cleanup-runner-cache', 'user', { timeoutMs: 1000 });
  assert.equal(t.result, 'exit-code');
  assert.equal(t.exitStatus, 1);
  assert.deepEqual(calls.map((c) => c[c.length - 1]), ['cleanup-runner-cache.timer', 'cleanup-runner-cache.timer', 'cleanup-runner-cache.service', 'cleanup-runner-cache.service']);
  assert.ok(calls.every((c) => c[1] === '--user'));
});

test('config.toml: what is kept, and no token, password or key ever comes out', () => {
  const text = fixtureText('config.toml');
  const cfg = parseConfigToml(text);
  assert.deepEqual(cfg, {
    concurrent: 4,
    listenAddress: ':9252',
    runners: [
      { name: 'desktop docker', url: 'https://gitlab.example.com', executor: 'docker', limit: 2, disableCache: false },
      { name: 'second', url: 'https://gitlab.com', executor: 'shell', limit: null, disableCache: null },
    ],
  });
  const out = JSON.stringify(cfg);
  for (const secret of [...text.matchAll(/FAKE[-A-Z0-9]*/g)].map((m) => m[0])) assert.ok(!out.includes(secret), secret);
  assert.ok(!/token|password|secret|key/i.test(out), out);
  assert.equal(cleanUrl('https://u:p@h.example.com:8443/gitlab/'), 'https://h.example.com:8443/gitlab');
  assert.equal(metricsUrlOf(':9252'), 'http://127.0.0.1:9252/metrics');
  assert.equal(metricsUrlOf('[::]:9252'), 'http://127.0.0.1:9252/metrics');
  assert.equal(metricsUrlOf('192.168.1.5:9252'), 'http://192.168.1.5:9252/metrics');
});

test('config.toml: a token-only key under any name is dropped (allowlist, not denylist)', () => {
  const cfg = parseConfigToml('concurrent = 1\nnew_auth_thing = "FAKE-NEW-ZZZ"\n[[runners]]\nname = "a"\nregistration = "FAKE-REG-ZZZ"\nurl = "https://x"\n');
  assert.ok(!JSON.stringify(cfg).includes('FAKE'));
});

// ── The reader, with a fake engine and a fake clock ────────────────────────

const T0 = Date.parse('2026-11-26T20:00:00Z');
const MIN = 60_000;

function machine(o: { engine?: 'docker' | 'podman'; down?: boolean } = {}) {
  const state = { df: 0, calls: [] as string[], argv: [] as string[][] };
  let saved: Saved = {};
  let fileRead = 0;
  const run: Run = async (cmd, args) => {
    state.calls.push([cmd, ...args].join(' '));
    state.argv.push([cmd, ...args]);
    if (cmd === 'docker' && o.engine === 'podman') throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
    if (o.down) return { stdout: '', stderr: 'Cannot connect to the Docker daemon at unix:///run/user/1000/docker.sock. Is the docker daemon running?', code: 1 };
    const pod = cmd === 'podman';
    const a = args.join(' ');
    if (a.startsWith('ps')) return { stdout: fixtureText(pod ? 'podman-ps.json' : 'docker-ps.jsonl'), stderr: '', code: 0 };
    if (a.startsWith('info')) return { stdout: fixtureText(pod ? 'podman-info.json' : 'docker-info-rootless.json'), stderr: '', code: 0 };
    if (a.startsWith('volume ls')) return { stdout: fixtureText(pod ? 'podman-volume-ls.json' : 'docker-volume-ls.jsonl'), stderr: '', code: 0 };
    if (a.startsWith('system df')) {
      state.df++;
      if (pod) return { stdout: fixtureText('podman-system-df-v.txt'), stderr: '', code: 0 };
      // Every measurement a bit bigger: the caches grow.
      const json = fixtureText('docker-system-df-v.json').replace('"2.1GB"', `"${(2.1 + state.df * 0.5).toFixed(1)}GB"`);
      return { stdout: json, stderr: '', code: 0 };
    }
    if (cmd === 'systemctl') {
      const unit = args[args.length - 1]!;
      return { stdout: fixtureText(unit.endsWith('.timer') ? 'systemctl-show-unix.txt' : 'systemctl-show-service.txt'), stderr: '', code: 0 };
    }
    throw new Error(`unexpected ${cmd} ${a}`);
  };
  const deps: LocalDeps = {
    run: guard(run),
    os: 'linux',
    env: { XDG_RUNTIME_DIR: '/run/user/1000' },
    exists: (p) => p === '/run/user/1000/docker.sock',
    statfs: async (p) => {
      if (p !== '/home/u/.local/share') throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return { bsize: 4096, blocks: (243.8 * GB) / 4096, bavail: (48.3 * GB) / 4096 };
    },
    readFile: async () => (fileRead++, fixtureText('config.toml')),
    store: { load: async () => saved, save: async (s) => void (saved = JSON.parse(JSON.stringify(s))) },
  };
  return { state, deps, saved: () => saved, fileRead: () => fileRead };
}

const OPTS: LocalOptions = { engine: 'auto', dockerHost: '', runnerContainer: '', sizesEveryMs: 30 * MIN, cleanupTimer: 'cleanup-runner-cache', timerScope: 'user', configToml: '' };

test('reader: runner, jobs, rootless disk (walking up to a folder it may stat), timer; sizes only in the background, after a minute, then every 30 min', async () => {
  const m = machine();
  const r = new LocalReader(m.deps, T0);
  let now = T0;
  const clock = () => now;
  let d = await r.read(OPTS, now, undefined, clock);
  assert.equal(d.engine, 'docker');
  assert.equal(d.rootless, true);
  assert.equal(d.runners[0]!.name, 'gitlab-runner');
  assert.equal(d.jobs.length, 2);
  assert.equal(d.disk!.path, '/home/u/.local/share');
  assert.ok(Math.abs(d.disk!.freeShare - 48.3 / 243.8) < 1e-6);
  assert.equal(d.timer!.lastAt, 1795661747000);
  assert.equal(d.sizes, null);
  assert.equal(d.nextSizesAt, T0 + MIN);
  assert.equal(m.state.df, 0, 'not measured while Kiosko starts');
  for (now = T0; now <= T0 + 3 * 3_600_000; now += 30_000) {
    d = await r.read(OPTS, now, undefined, clock);
    await r.idle();
  }
  // At T0+1 min, then every 30 min: 1, 31, 61, 91, 121 and 151 min.
  assert.equal(m.state.df, 6);
  d = await r.read(OPTS, now, undefined, clock);
  assert.equal(d.sizes!.total.count, 6);
  assert.equal(d.history.length, 6);
  // 0.5 GB every 30 min: 24 GB a day.
  assert.ok(Math.abs(d.growth.perDay! - 24 * GB) < 0.01 * GB, String(d.growth.perDay));
  // Two and a half hours of data: what was added, but no projection yet.
  assert.equal(d.growth.reliable, false);
  assert.ok(Math.abs(d.growth.added - 2.5 * GB) < 1e6, String(d.growth.added));
  assert.equal(d.fullInDays, null);
  // Every command it ran was on the read-only list, and nothing else was tried.
  for (const [cmd, ...args] of m.state.argv) assert.ok(isReadOnly(cmd!, args), [cmd, ...args].join(' '));
  // The history survives a restart: a new reader shows the last sizes at once and waits for the interval.
  const again = new LocalReader(m.deps, now);
  const d2 = await again.read(OPTS, now + 1000, undefined, () => now + 1000);
  assert.equal(d2.sizes!.at, d.sizes!.at);
  assert.equal(d2.history.length, 6);
  assert.equal(d2.measuring, false);
});

test('reader: Podman when there is no docker, with its own formats', async () => {
  const m = machine({ engine: 'podman' });
  const r = new LocalReader(m.deps, T0 - 10 * MIN);
  const d0 = await r.read({ ...OPTS, cleanupTimer: '' }, T0, undefined, () => T0);
  assert.equal(d0.engine, 'podman');
  assert.equal(d0.timer, null);
  assert.deepEqual(d0.jobs.map((j) => j.project), ['data-pipeline']);
  await r.idle();
  const d = await r.read({ ...OPTS, cleanupTimer: '' }, T0 + 1000, undefined, () => T0 + 1000);
  assert.equal(d.sizes!.total.bytes, 4.75 * GB);
  assert.ok(m.state.calls.some((c) => c === 'podman ps -a --format json'));
  assert.ok(m.state.calls.some((c) => c === 'podman system df -v'));
});

test('reader: Docker not answering says so, and config.toml is read only when set', async () => {
  const m = machine({ down: true });
  const r = new LocalReader(m.deps, T0);
  const d = await r.read({ ...OPTS, configToml: '/etc/gitlab-runner/config.toml' }, T0);
  assert.equal(d.error, 'not-running');
  assert.equal(d.config!.concurrent, 4);
  assert.ok(!JSON.stringify(d).includes('FAKE'));
  const m2 = machine();
  await new LocalReader(m2.deps, T0).read(OPTS, T0);
  assert.equal(m2.fileRead(), 0);
});
