/**
 * GitHub Actions self-hosted runners, with a token (fine-grained: the
 * repository's "Administration: read" for its runners and "Actions: read"
 * for its runs; the organisation's "Self-hosted runners: read"):
 *
 * - `GET /repos/{owner}/{repo}/actions/runners` and
 *   `GET /orgs/{org}/actions/runners`: name, `status` (online/offline),
 *   `busy`, labels.
 * - `GET /repos/{owner}/{repo}/actions/runs?status=queued` and
 *   `?status=in_progress`: the runs waiting and running, and how long the
 *   oldest queued one has waited.
 *
 * Shapes as documented at docs.github.com/rest/actions/self-hosted-runners
 * and /rest/actions/workflow-runs. GitHub Enterprise Server: its API
 * address (`https://github.example.com/api/v3`) in the options.
 */
import { L } from '../i18n.ts';
import type { ApiData, ApiJob, ApiRunner } from '../types.ts';
import { baseUrl, errorWord, isoMs, oldest, type RemoteContext, type RemoteOptions, type RemoteProvider } from './provider.ts';

export interface GhRunner {
  id: number;
  name: string;
  os?: string;
  status: string;
  busy: boolean;
  labels?: { name: string; type?: string }[];
}

export interface GhRun {
  id: number;
  name?: string | null;
  status: string;
  created_at?: string;
  run_started_at?: string;
  repository?: { name?: string };
}

export const MAX_REPOS = 10;

export function mapGhRunner(r: GhRunner): ApiRunner {
  return {
    id: String(r.id),
    name: r.name.slice(0, 60),
    status: r.status === 'online' ? 'online' : 'offline',
    busy: r.busy,
    contactedAt: null,
    version: null,
    // The custom ones say most: `gpu`, `arm64-big`; then the default ones.
    labels: (r.labels ?? []).sort((a, b) => Number(a.type !== 'custom') - Number(b.type !== 'custom')).map((l) => l.name).slice(0, 8),
  };
}

export function mapGhRun(r: GhRun, repo: string): ApiJob {
  return {
    id: String(r.id),
    project: r.repository?.name ?? repo.split('/').pop()!,
    name: (r.name ?? '').slice(0, 60),
    status: r.status === 'in_progress' ? 'in_progress' : 'queued',
    createdAt: isoMs(r.created_at),
    startedAt: r.status === 'in_progress' ? isoMs(r.run_started_at) : null,
  };
}

export async function readGithub(o: RemoteOptions, ctx: RemoteContext): Promise<ApiData> {
  const api = baseUrl(o.githubApi, 'https://api.github.com');
  const req = { headers: { Authorization: `Bearer ${o.githubToken.trim()}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, ...(ctx.signal ? { signal: ctx.signal } : {}) };
  const get = async <T>(path: string): Promise<T> => (await ctx.http.json<T>(`${api}${path}`, req)).data;
  const slug = (s: string) => s.trim().replace(/^\/+|\/+$/g, '').split('/').map(encodeURIComponent).join('/');
  try {
    const runners = new Map<string, ApiRunner>();
    const jobs: ApiJob[] = [];
    let queuedTotal = 0;
    let runningTotal = 0;
    for (const org of o.githubOrgs.map((x) => x.trim()).filter(Boolean)) {
      const d = await get<{ runners: GhRunner[] }>(`/orgs/${slug(org)}/actions/runners?per_page=100`);
      for (const r of d.runners ?? []) runners.set(String(r.id), mapGhRunner(r));
    }
    for (const repo of o.githubRepos.map((x) => x.trim()).filter((x) => x.includes('/')).slice(0, MAX_REPOS)) {
      // A repository's own runners need admin rights on it; without them its runs still count.
      const own = await get<{ runners: GhRunner[] }>(`/repos/${slug(repo)}/actions/runners?per_page=100`).catch((e) => {
        if ((e as { status?: number }).status === 403 || (e as { status?: number }).status === 404) return { runners: [] };
        throw e;
      });
      for (const r of own.runners ?? []) runners.set(String(r.id), mapGhRunner(r));
      const q = await get<{ total_count: number; workflow_runs: GhRun[] }>(`/repos/${slug(repo)}/actions/runs?status=queued&per_page=50`);
      const p = await get<{ total_count: number; workflow_runs: GhRun[] }>(`/repos/${slug(repo)}/actions/runs?status=in_progress&per_page=50`);
      queuedTotal += q.total_count ?? q.workflow_runs?.length ?? 0;
      runningTotal += p.total_count ?? p.workflow_runs?.length ?? 0;
      for (const r of [...(q.workflow_runs ?? []), ...(p.workflow_runs ?? [])]) jobs.push(mapGhRun(r, repo));
    }
    const queued = jobs.filter((j) => j.status === 'queued');
    return { at: ctx.now, runners: [...runners.values()], pending: queuedTotal, running: runningTotal, oldestPendingAt: oldest(queued.map((j) => j.createdAt)), jobs };
  } catch (e) {
    ctx.log?.(`runners: GitHub: ${errorWord(e)}`);
    return { at: ctx.now, error: errorWord(e), runners: [], pending: 0, running: 0, oldestPendingAt: null, jobs: [] };
  }
}

export const github: RemoteProvider<ApiData> = {
  id: 'github',
  name: L('GitHub Actions', 'GitHub Actions', 'GitHub Actions', 'GitHub Actions', 'GitHub Actions'),
  hosts: ['api.github.com'],
  enabled: (o) => !!o.githubToken.trim() && (o.githubRepos.length > 0 || o.githubOrgs.length > 0),
  everyMs: 2 * 60_000,
  read: readGithub,
};
