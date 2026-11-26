import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttp } from '@kiosko/sdk';
import { fixture, fixtureText } from './fixtures.ts';
import { readGithub } from './providers/github.ts';
import { mapRunner, readGitlab, runnerStatus } from './providers/gitlab.ts';
import { metricsOf, parseProm, readMetrics } from './providers/metrics.ts';
import type { RemoteOptions } from './providers/provider.ts';

const NOW = Date.parse('2026-11-26T20:10:00Z');
const TOKEN = 'glpat-FAKE-TOKEN-ZZZ';
const OPTS: RemoteOptions = { gitlabUrl: 'gitlab.example.com', gitlabToken: TOKEN, gitlabProjects: ['acme/web'], gitlabGroups: [], githubApi: '', githubToken: 'ghp_FAKE_ZZZ', githubRepos: ['octo-org/app'], githubOrgs: [], metricsUrl: '' };

/** A fake server: answers by path, records what was asked and with which headers. */
function server(routes: Record<string, unknown>, status: Record<string, number> = {}) {
  const asked: { url: string; headers: Record<string, string> }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const path = `${u.pathname}${u.search}`;
    asked.push({ url: path, headers: (init?.headers ?? {}) as Record<string, string> });
    const key = Object.keys(routes).find((k) => path === k || path.startsWith(`${k}?`));
    if (status[path.split('?')[0]!]) return new Response('{"message":"401 Unauthorized"}', { status: status[path.split('?')[0]!] });
    if (!key) return new Response('{"message":"404 Not found"}', { status: 404 });
    const body = routes[key];
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { http: createHttp({ fetch: f }), asked };
}

const GL = {
  '/api/v4/runners': fixture('gitlab-runners.json'),
  '/api/v4/runners/41': fixture('gitlab-runner-41.json'),
  '/api/v4/runners/41/managers': fixture('gitlab-runner-41-managers.json'),
  '/api/v4/runners/38': fixture('gitlab-runner-38.json'),
  '/api/v4/runners/12': fixture('gitlab-runner-12.json'),
  '/api/v4/projects/acme%2Fweb/jobs': fixture('gitlab-jobs-web.json'),
  '/api/v4/projects/acme%2Ftools%2Fapi/jobs': fixture('gitlab-jobs-api.json'),
  '/api/v4/groups/acme/projects': fixture('gitlab-group-projects.json'),
};

test('GitLab: runners with their status, last contact and version (from managers on GitLab 17+), busy from the running jobs', async () => {
  const s = server(GL);
  const d = await readGitlab(OPTS, { http: s.http, now: NOW });
  assert.equal(d.error, undefined);
  assert.deepEqual(d.runners.map((r) => [r.id, r.name, r.status, r.busy, r.version]), [['41', 'desktop docker', 'online', true, '19.5.1'], ['38', 'old laptop', 'offline', false, '18.2.0'], ['12', 'spare', 'paused', false, null]]);
  assert.equal(d.runners[0]!.contactedAt, Date.parse('2026-11-26T20:09:40Z'));
  assert.deepEqual(d.runners[0]!.labels, ['docker', 'linux']);
  assert.deepEqual([d.pending, d.running, d.oldestPendingAt], [1, 1, Date.parse('2026-11-26T20:01:00Z')]);
  // Only endpoints a non-admin may use, the token as PRIVATE-TOKEN, never in the URL.
  for (const a of s.asked) {
    assert.match(a.url, /^\/api\/v4\/(runners|projects|groups)/);
    assert.ok(!a.url.includes(TOKEN));
    assert.equal(a.headers['PRIVATE-TOKEN'], TOKEN);
  }
  assert.ok(!s.asked.some((a) => a.url.startsWith('/api/v4/runners/all')), 'never the admin-only list');
  assert.ok(s.asked.some((a) => a.url === '/api/v4/projects/acme%2Fweb/jobs?scope%5B%5D=pending&scope%5B%5D=running&per_page=100'));
});

test('GitLab: a group brings its projects; a wrong token is a short word, not a stack', async () => {
  const d = await readGitlab({ ...OPTS, gitlabProjects: [], gitlabGroups: ['acme'] }, { http: server(GL).http, now: NOW });
  assert.deepEqual(d.jobs.map((j) => [j.project, j.name, j.status]), [['web', 'test', 'running'], ['web', 'lint', 'pending'], ['api', 'e2e', 'pending']]);
  assert.equal(d.pending, 2);
  const bad = await readGitlab(OPTS, { http: server(GL, { '/api/v4/projects/acme%2Fweb/jobs': 401 }).http, now: NOW });
  assert.equal(bad.error, 'unauthorized');
  assert.ok(!JSON.stringify(bad).includes(TOKEN));
  assert.equal(runnerStatus({ id: 1, status: 'never_contacted' }), 'never_contacted');
  assert.equal(mapRunner({ id: 1, online: true }).status, 'online');
});

test('GitHub: self-hosted runners (busy, labels with custom ones first) and queued runs with the oldest wait', async () => {
  // Two answers on one path: in progress when asked for it.
  const f = (async (url: string, init?: RequestInit) => {
    if (url.includes('status=in_progress')) return new Response(fixtureText('github-runs-in-progress.json'));
    return fetchVia(url, init);
  }) as typeof fetch;
  const routes = new Map([
    ['/repos/octo-org/app/actions/runners', fixtureText('github-runners.json')],
    ['/repos/octo-org/app/actions/runs?status=queued', fixtureText('github-runs-queued.json')],
  ]);
  const asked: Record<string, string>[] = [];
  async function fetchVia(url: string, init?: RequestInit) {
    asked.push((init?.headers ?? {}) as Record<string, string>);
    const u = new URL(url);
    const key = [...routes.keys()].find((k) => `${u.pathname}${u.search}`.startsWith(k));
    return new Response(key ? routes.get(key)! : '{}', { status: key ? 200 : 404 });
  }
  const d = await readGithub(OPTS, { http: createHttp({ fetch: f }), now: NOW });
  assert.equal(d.error, undefined);
  assert.deepEqual(d.runners.map((r) => [r.name, r.status, r.busy, r.labels[0]]), [['build-box', 'online', true, 'gpu'], ['mac-mini', 'offline', false, 'self-hosted']]);
  assert.deepEqual([d.pending, d.running, d.oldestPendingAt], [2, 1, Date.parse('2026-11-26T19:40:00Z')]);
  assert.ok(asked.every((h) => h.Authorization === 'Bearer ghp_FAKE_ZZZ' && h['X-GitHub-Api-Version'] === '2022-11-28'));
});

test('GitHub: no admin rights on the repository still counts its runs', async () => {
  const f = (async (url: string) => {
    if (url.includes('/actions/runners')) return new Response('{"message":"Must have admin rights to Repository."}', { status: 403 });
    if (url.includes('status=queued')) return new Response(fixtureText('github-runs-queued.json'));
    return new Response('{"total_count":0,"workflow_runs":[]}');
  }) as typeof fetch;
  const d = await readGithub(OPTS, { http: createHttp({ fetch: f }), now: NOW });
  assert.deepEqual([d.error, d.runners.length, d.pending], [undefined, 0, 2]);
});

test('Prometheus metrics of gitlab-runner', () => {
  const xs = parseProm(fixtureText('metrics.txt'));
  assert.ok(xs.length >= 10);
  assert.deepEqual(metricsOf(fixtureText('metrics.txt'), NOW), { at: NOW, version: '19.5.1', concurrent: 4, running: 2, jobsTotal: 1840, failedTotal: 61, errorsTotal: 3, startedAt: 1795247529120 });
  assert.throws(() => metricsOf('node_cpu_seconds_total 1\n', NOW), /not gitlab-runner/);
});

test('metrics: read from config.toml’s listen_address when no address is set; down is a word', async () => {
  let asked = '';
  const f = (async (url: string) => ((asked = url), new Response(fixtureText('metrics.txt')))) as typeof fetch;
  const d = await readMetrics(OPTS, { http: createHttp({ fetch: f }), now: NOW, metricsFallback: 'http://127.0.0.1:9252/metrics' });
  assert.equal(asked, 'http://127.0.0.1:9252/metrics');
  assert.equal(d.running, 2);
  const down = (async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  }) as typeof fetch;
  const e = await readMetrics({ ...OPTS, metricsUrl: 'http://127.0.0.1:9252/metrics' }, { http: createHttp({ fetch: down }), now: NOW });
  assert.equal(e.error, 'econnrefused');
});
