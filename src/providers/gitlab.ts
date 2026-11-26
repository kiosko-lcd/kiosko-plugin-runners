/**
 * GitLab's REST API (v4), with a personal, project or group access token
 * with `read_api`, sent as `PRIVATE-TOKEN`. Only endpoints an ordinary
 * (non-admin) user may call:
 *
 * - `GET /runners` — the runners the token's user owns or can manage
 *   (`status`: online, offline, stale, never_contacted; `paused`);
 *   `GET /runners/:id` for when it was last in touch and its version,
 *   `GET /runners/:id/managers` for the version on GitLab 17 and later.
 * - `GET /projects/:id/jobs?scope[]=pending&scope[]=running` for each
 *   project set, and the projects of each group set
 *   (`GET /groups/:id/projects`, most recently active first): the jobs
 *   waiting for a runner and the ones running, and how long the oldest
 *   has waited.
 *
 * Shapes as documented at docs.gitlab.com/api/runners and /api/jobs.
 */
import { L } from '../i18n.ts';
import type { ApiData, ApiJob, ApiRunner, ApiRunnerStatus } from '../types.ts';
import { baseUrl, errorWord, isoMs, oldest, type RemoteContext, type RemoteOptions, type RemoteProvider } from './provider.ts';

export interface GlRunner {
  id: number;
  description?: string | null;
  name?: string | null;
  paused?: boolean;
  active?: boolean;
  online?: boolean | null;
  status?: string;
  runner_type?: string;
  is_shared?: boolean;
}

export interface GlRunnerDetail extends GlRunner {
  contacted_at?: string | null;
  version?: string | null;
  tag_list?: string[];
}

export interface GlManager {
  system_id?: string;
  version?: string | null;
  contacted_at?: string | null;
  status?: string;
}

export interface GlJob {
  id: number;
  status: string;
  stage?: string;
  name?: string;
  ref?: string;
  created_at?: string | null;
  started_at?: string | null;
  web_url?: string;
  runner?: { id?: number } | null;
}

export const MAX_RUNNERS = 10;
export const MAX_PROJECTS = 20;

export function runnerStatus(r: GlRunner): ApiRunnerStatus {
  if (r.paused || r.active === false) return 'paused';
  const s = (r.status ?? '').toLowerCase();
  if (s === 'online' || s === 'offline' || s === 'stale' || s === 'never_contacted') return s;
  return r.online ? 'online' : 'offline';
}

export function mapRunner(r: GlRunner, detail?: GlRunnerDetail | null, managers?: GlManager[] | null, busy?: Set<number>): ApiRunner {
  const latest = (managers ?? []).slice().sort((a, b) => (isoMs(b.contacted_at) ?? 0) - (isoMs(a.contacted_at) ?? 0))[0];
  return {
    id: String(r.id),
    name: (r.description || r.name || `#${r.id}`).slice(0, 60),
    status: runnerStatus(detail ?? r),
    busy: busy ? busy.has(r.id) : null,
    contactedAt: isoMs(detail?.contacted_at) ?? isoMs(latest?.contacted_at),
    version: detail?.version || latest?.version || null,
    labels: (detail?.tag_list ?? []).slice(0, 8),
  };
}

/** `https://gitlab.com/group/web/-/jobs/1` → `web`; else the project as given. */
export function projectName(job: GlJob, asked: string): string {
  const m = /\/([^/]+)\/-\/jobs\//.exec(job.web_url ?? '');
  return m ? decodeURIComponent(m[1]!) : asked.split('/').pop()!;
}

export function mapJob(j: GlJob, project: string): ApiJob {
  return {
    id: String(j.id),
    project: projectName(j, project),
    name: (j.name ?? '').slice(0, 60),
    status: j.status === 'running' ? 'running' : 'pending',
    createdAt: isoMs(j.created_at),
    startedAt: isoMs(j.started_at),
  };
}

export function summarize(runners: ApiRunner[], jobs: ApiJob[], at: number): ApiData {
  const pending = jobs.filter((j) => j.status === 'pending');
  return { at, runners, pending: pending.length, running: jobs.length - pending.length, oldestPendingAt: oldest(pending.map((j) => j.createdAt)), jobs };
}

const enc = (p: string) => encodeURIComponent(p.trim().replace(/^\/+|\/+$/g, ''));

export async function readGitlab(o: RemoteOptions, ctx: RemoteContext): Promise<ApiData> {
  const api = `${baseUrl(o.gitlabUrl, 'https://gitlab.com')}/api/v4`;
  const req = { headers: { 'PRIVATE-TOKEN': o.gitlabToken.trim() }, ...(ctx.signal ? { signal: ctx.signal } : {}), noCache: true };
  const get = async <T>(path: string): Promise<T> => (await ctx.http.json<T>(`${api}${path}`, req)).data;
  try {
    const projects = new Set(o.gitlabProjects.map((p) => p.trim()).filter(Boolean));
    for (const g of o.gitlabGroups.map((x) => x.trim()).filter(Boolean)) {
      if (projects.size >= MAX_PROJECTS) break;
      const list = await get<{ path_with_namespace: string }[]>(`/groups/${enc(g)}/projects?include_subgroups=true&archived=false&order_by=last_activity_at&simple=true&per_page=${MAX_PROJECTS}`);
      for (const p of list) projects.add(p.path_with_namespace);
    }
    const jobs: ApiJob[] = [];
    const busy = new Set<number>();
    for (const p of [...projects].slice(0, MAX_PROJECTS)) {
      const list = await get<GlJob[]>(`/projects/${enc(p)}/jobs?scope%5B%5D=pending&scope%5B%5D=running&per_page=100`);
      for (const j of list) {
        jobs.push(mapJob(j, p));
        if (j.status === 'running' && j.runner?.id !== undefined) busy.add(j.runner.id);
      }
    }
    const list = await get<GlRunner[]>('/runners?per_page=100');
    const runners: ApiRunner[] = [];
    for (const r of list.slice(0, MAX_RUNNERS)) {
      const detail = await get<GlRunnerDetail>(`/runners/${r.id}`).catch(() => null);
      const managers = detail?.version ? null : await get<GlManager[]>(`/runners/${r.id}/managers`).catch(() => null);
      runners.push(mapRunner(r, detail, managers, projects.size ? busy : undefined));
    }
    return summarize(runners, jobs, ctx.now);
  } catch (e) {
    ctx.log?.(`runners: GitLab: ${errorWord(e)}`);
    return { at: ctx.now, error: errorWord(e), runners: [], pending: 0, running: 0, oldestPendingAt: null, jobs: [] };
  }
}

export const gitlab: RemoteProvider<ApiData> = {
  id: 'gitlab',
  name: L('GitLab API', 'API de GitLab', 'GitLab-API', 'GitLab API', 'GitLab API'),
  hosts: ['gitlab.com'],
  enabled: (o) => !!o.gitlabToken.trim(),
  everyMs: 2 * 60_000,
  read: readGitlab,
};
