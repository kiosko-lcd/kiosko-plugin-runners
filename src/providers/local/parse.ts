/**
 * Reading what Docker and Podman print, the same way for both:
 *
 * - `ps` / `volume ls`: Docker with `--format '{{json .}}'` prints one JSON
 *   object per line, labels as one `k=v,k2=v2` string; Podman with
 *   `--format json` prints one JSON array, labels as an object.
 * - `system df -v`: Docker 23+ takes `--format '{{json .}}'` (sizes as
 *   text: `561.2MB`); older Docker and Podman print tables, read here by
 *   their "Local Volumes space usage" section.
 * - `info`: Docker's `DockerRootDir` and `SecurityOptions` (`name=rootless`),
 *   Podman's `store.graphRoot` and `host.security.rootless`.
 *
 * Volumes the GitLab runner makes are `runner-<id>-cache-<md5 of the path>`
 * with `-protected` for protected refs, labelled
 * `com.gitlab.gitlab-runner.managed=true`, `…destination=/cache|/builds`
 * and `…protected=true`. Without labels (a table), the name says it: the
 * md5 of `/cache` and of `/builds` are fixed.
 */
import type { LocalJob, RunnerContainer, Tally, VolumeSizes } from '../../types.ts';

export const RUNNER_LABEL = 'com.gitlab.gitlab-runner';
export const MANAGED_LABEL = `${RUNNER_LABEL}.managed`;
/** md5("/cache") and md5("/builds"): the last part of a runner volume's name. */
export const CACHE_HASH = '3c3f060a0374fc8bc39395164f415a70';
export const BUILDS_HASH = 'c33bcaa1fd2c77edfc3893b41966cea8';
const VOLUME_NAME = /^runner-[0-9a-z]+-cache-([0-9a-f]{32})(-protected)?$/;

export type Labels = Record<string, string>;

/** Docker's `k=v,k2=v2` (a value may hold commas: a new pair starts only at `,key=`), or Podman's object. */
export function parseLabels(v: unknown): Labels {
  if (v && typeof v === 'object' && !Array.isArray(v)) return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, String(x ?? '')]));
  if (typeof v !== 'string' || !v) return {};
  const out: Labels = {};
  const parts = v.split(/,(?=[A-Za-z0-9_.\-/]+=)/);
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i <= 0) continue;
    out[p.slice(0, i)] = p.slice(i + 1);
  }
  return out;
}

/** One JSON object per line (Docker) or one array (Podman). Lines that aren't JSON are skipped. */
export function parseJsonRows(text: string): Record<string, unknown>[] {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith('[')) {
    try {
      const a = JSON.parse(t) as unknown;
      return Array.isArray(a) ? (a.filter((x) => x && typeof x === 'object') as Record<string, unknown>[]) : [];
    } catch {
      return [];
    }
  }
  const out: Record<string, unknown>[] = [];
  for (const line of t.split(/\r?\n/)) {
    const l = line.trim();
    if (!l.startsWith('{')) continue;
    try {
      out.push(JSON.parse(l) as Record<string, unknown>);
    } catch {
      /* a line cut short */
    }
  }
  return out;
}

const UNITS: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, k: 1e3, m: 1e6, g: 1e9, t: 1e12 };

/** `561.2MB`, `1.2 GB`, `0B`, `3.5GiB` → bytes; `N/A`, `-` → null. */
export function parseSize(s: unknown): number | null {
  if (typeof s === 'number') return Number.isFinite(s) && s >= 0 ? s : null;
  if (typeof s !== 'string') return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kmgtp]i?b?|b)?\s*$/i.exec(s);
  if (!m) return null;
  const unit = (m[2] ?? 'b').toLowerCase();
  const f = UNITS[unit];
  return f === undefined ? null : Math.round(Number(m[1]) * f);
}

/** Docker's `2026-11-16 10:32:09 +0100 CET`, an ISO date, or epoch seconds (Podman) → epoch ms. */
export function parseCreated(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
  if (typeof v !== 'string' || !v) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*([+-]\d{2}):?(\d{2})/.exec(v);
  if (m) return Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`);
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export interface Container {
  startedAt: number | null;
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  labels: Labels;
  createdAt: number | null;
}

/** `docker ps -a --format '{{json .}}'` or `podman ps -a --format json`. */
export function parsePs(text: string): Container[] {
  return parseJsonRows(text).map((r) => {
    const names = Array.isArray(r.Names) ? (r.Names as unknown[]).map(String) : String(r.Names ?? '').split(',');
    const status = String(r.Status ?? '');
    let state = String(r.State ?? '').toLowerCase();
    // Old Docker has no State: the status says it.
    if (!state) state = /^up\b/i.test(status) ? (/\(paused\)/i.test(status) ? 'paused' : 'running') : /^restarting/i.test(status) ? 'restarting' : /^exited/i.test(status) ? 'exited' : /^created/i.test(status) ? 'created' : 'unknown';
    return {
      id: String(r.ID ?? r.Id ?? '').slice(0, 12),
      name: (names[0] ?? '').replace(/^\//, ''),
      image: String(r.Image ?? ''),
      state,
      status,
      labels: parseLabels(r.Labels),
      createdAt: parseCreated(r.Created ?? r.CreatedAt),
      startedAt: typeof r.StartedAt === 'number' && r.StartedAt > 0 ? parseCreated(r.StartedAt) : null,
    };
  });
}

const UNIT_MS: Record<string, number> = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000, year: 365 * 86_400_000 };

/** How long it has been up, from Docker's "Up 10 days", "Up About an hour", "Up Less than a second"; null when not up. */
export function uptimeOf(status: string): number | null {
  const m = /^Up\s+(.+?)(?:\s+\(.*\))?$/i.exec(status.trim());
  if (!m) return null;
  const t = m[1]!.toLowerCase();
  if (/less than a second/.test(t)) return 0;
  const u = /(about an?|\d+)\s+(second|minute|hour|day|week|month|year)s?/.exec(t);
  if (!u) return null;
  const n = /^about/.test(u[1]!) ? 1 : Number(u[1]);
  return n * UNIT_MS[u[2]!]!;
}

/** `(healthy)` in the status, or null. */
export function healthOf(status: string): string | null {
  const m = /\((healthy|unhealthy|health: starting|starting)\)/i.exec(status);
  if (!m) return null;
  return m[1]!.toLowerCase().replace('health: ', '');
}

/** `gitlab/gitlab-runner:v19.5.1` → `19.5.1`; `alpine-v17.4.0` → `17.4.0`; `latest` → null. */
export function versionOfImage(image: string): string | null {
  const tag = /:([^:/@]+)(?:@.*)?$/.exec(image)?.[1] ?? '';
  const m = /v?(\d+\.\d+(?:\.\d+)?)/.exec(tag);
  return m ? m[1]! : null;
}

/** The runner itself: the container named in the options, or (by default) any whose image is gitlab-runner, not its helper. */
export function isRunnerContainer(c: Container, name: string): boolean {
  if (name) return c.name === name;
  if (c.labels[`${RUNNER_LABEL}.job.id`]) return false;
  return /(^|\/)gitlab-runner(:|@|$)/.test(c.image) || (c.name === 'gitlab-runner' && !/helper/.test(c.image));
}

export function runnersOf(cs: Container[], name = '', now = Date.now()): RunnerContainer[] {
  return cs
    .filter((c) => isRunnerContainer(c, name))
    .map((c) => {
      const up = uptimeOf(c.status);
      return { name: c.name, image: c.image, version: versionOfImage(c.image), state: c.state, health: healthOf(c.status), createdAt: c.createdAt, startedAt: c.startedAt ?? (up !== null ? now - up : null), status: c.status };
    });
}

/** `https://gitlab.example.com/group/sub/web/-/jobs/42` → `web`. */
export function projectOfUrl(url: string | undefined): string | null {
  if (!url) return null;
  const m = /\/([^/]+)\/-\/jobs\//.exec(url);
  return m ? decodeURIComponent(m[1]!) : null;
}

/** Jobs running now: one per job id, from its build (or service) containers; helpers are left out. */
export function jobsOf(cs: Container[]): LocalJob[] {
  const byId = new Map<string, LocalJob>();
  for (const c of cs) {
    if (c.state !== 'running') continue;
    const id = c.labels[`${RUNNER_LABEL}.job.id`];
    if (!id) continue;
    const kind = c.labels[`${RUNNER_LABEL}.type`] ?? 'build';
    if (kind === 'predefined' || kind === 'cache' || kind === 'wait') continue;
    const prev = byId.get(id);
    const startedAt = prev?.startedAt != null && c.createdAt != null ? Math.min(prev.startedAt, c.createdAt) : (prev?.startedAt ?? c.createdAt);
    byId.set(id, {
      id,
      project: prev?.project ?? projectOfUrl(c.labels[`${RUNNER_LABEL}.job.url`]),
      ref: prev?.ref ?? c.labels[`${RUNNER_LABEL}.job.ref`]?.replace(/^refs\/(heads|tags)\//, '') ?? null,
      kind: prev?.kind === 'build' ? 'build' : kind,
      startedAt,
    });
  }
  return [...byId.values()].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

export interface Volume {
  name: string;
  labels: Labels;
}

/** `docker volume ls --format '{{json .}}'` or `podman volume ls --format json`. */
export function parseVolumes(text: string): Volume[] {
  return parseJsonRows(text).map((r) => ({ name: String(r.Name ?? ''), labels: parseLabels(r.Labels) }));
}

export interface SizedVolume {
  name: string;
  bytes: number | null;
  labels?: Labels;
}

/** `docker system df -v --format '{{json .}}'`: its `Volumes`. Null when the text isn't that JSON. */
export function parseSystemDfJson(text: string): SizedVolume[] | null {
  const t = text.trim();
  if (!t.startsWith('{')) return null;
  try {
    const d = JSON.parse(t.split(/\r?\n/)[0]!) as { Volumes?: { Name?: string; Size?: string; Labels?: unknown }[] };
    if (!Array.isArray(d.Volumes)) return null;
    return d.Volumes.map((v) => ({ name: String(v.Name ?? ''), bytes: parseSize(v.Size), labels: parseLabels(v.Labels) }));
  } catch {
    return null;
  }
}

/** The "Local Volumes space usage" table of `system df -v` (older Docker, Podman). */
export function parseSystemDfTable(text: string): SizedVolume[] | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^local volumes space usage/i.test(l.trim()));
  if (start < 0) return null;
  const out: SizedVolume[] = [];
  let header: string[] | null = null;
  for (const raw of lines.slice(start + 1)) {
    const l = raw.trim();
    if (!l) {
      if (header) {
        if (out.length) break;
        continue;
      }
      continue;
    }
    if (/space usage:?$/i.test(l)) break;
    const cols = l.split(/\s{2,}|\t+/);
    if (!header) {
      header = cols.map((c) => c.toUpperCase());
      continue;
    }
    const name = cols[header.indexOf('VOLUME NAME')] ?? cols[0] ?? '';
    const size = cols[header.indexOf('SIZE')] ?? cols[cols.length - 1];
    out.push({ name, bytes: parseSize(size) });
  }
  return out;
}

export type VolumeKind = 'cache' | 'builds' | 'other';

/** Whether the runner made it, what it holds and whether it's for protected refs: from the labels, else the name. */
export function kindOf(name: string, labels: Labels = {}): { kind: VolumeKind; protected: boolean } {
  const managed = labels[MANAGED_LABEL] === 'true';
  const m = VOLUME_NAME.exec(name);
  if (!managed && !m) return { kind: 'other', protected: false };
  const dest = labels[`${RUNNER_LABEL}.destination`];
  const prot = labels[`${RUNNER_LABEL}.protected`] === 'true' || /-protected$/.test(name);
  if (dest) return { kind: dest === '/cache' || /cache/.test(dest) ? 'cache' : 'builds', protected: prot };
  if (m?.[1] === CACHE_HASH) return { kind: 'cache', protected: prot };
  if (m?.[1] === BUILDS_HASH) return { kind: 'builds', protected: prot };
  // A custom path (`volumes = ["/my/cache"]` or a builds_dir elsewhere): counted with the clones.
  return { kind: 'builds', protected: prot };
}

const tally = (): Tally => ({ count: 0, bytes: 0 });
const add = (t: Tally, b: number) => {
  t.count++;
  t.bytes += b;
};

/** Adds up sizes by kind; labels come with the sizes (Docker's JSON) or from `volume ls`. */
export function summarizeVolumes(sized: SizedVolume[], labelled: Volume[], at: number, tookMs: number): VolumeSizes {
  const labels = new Map(labelled.map((v) => [v.name, v.labels]));
  const s: VolumeSizes = { at, tookMs, total: tally(), cache: tally(), builds: tally(), protected: tally(), unprotected: tally(), other: tally(), largest: 0 };
  for (const v of sized) {
    const b = v.bytes ?? 0;
    const k = kindOf(v.name, v.labels && Object.keys(v.labels).length ? v.labels : (labels.get(v.name) ?? {}));
    if (k.kind === 'other') {
      add(s.other, b);
      continue;
    }
    add(s.total, b);
    add(k.kind === 'cache' ? s.cache : s.builds, b);
    add(k.protected ? s.protected : s.unprotected, b);
    s.largest = Math.max(s.largest, b);
  }
  return s;
}

export interface EngineInfo {
  serverVersion: string | null;
  rootDir: string | null;
  rootless: boolean;
  /** What the engine said went wrong, when it printed something but no server. */
  error?: string;
}

/** `docker info --format '{{json .}}'` or `podman info --format json`. */
export function parseInfo(text: string): EngineInfo {
  let d: Record<string, any>;
  const t = text.trim();
  try {
    d = JSON.parse(t) as Record<string, any>;
  } catch {
    try {
      // A warning printed before Docker's one-line JSON.
      d = JSON.parse(t.split(/\r?\n/).find((l) => l.trim().startsWith('{')) ?? '') as Record<string, any>;
    } catch {
      return { serverVersion: null, rootDir: null, rootless: false, error: 'not json' };
    }
  }
  if (d.store || d.host) {
    // Podman.
    return {
      serverVersion: d.version?.Version ?? null,
      rootDir: d.store?.volumePath ?? (d.store?.graphRoot ? `${d.store.graphRoot}/volumes` : null),
      rootless: Boolean(d.host?.security?.rootless),
    };
  }
  const errs = Array.isArray(d.ServerErrors) ? (d.ServerErrors as string[]) : [];
  const sec = Array.isArray(d.SecurityOptions) ? (d.SecurityOptions as string[]) : [];
  return {
    serverVersion: d.ServerVersion || null,
    rootDir: d.DockerRootDir || null,
    rootless: sec.some((x) => /name=rootless/.test(String(x))),
    ...(errs.length && !d.ServerVersion ? { error: errs.join('; ') } : {}),
  };
}

export type EngineProblem = 'missing' | 'not-running' | 'permission' | 'other';

/** Why the engine didn't answer, from what it printed. */
export function problemOf(text: string): EngineProblem {
  if (/permission denied/i.test(text)) return 'permission';
  if (/cannot connect|is the docker daemon running|no such file or directory|connection refused|unable to connect to podman|dial unix/i.test(text)) return 'not-running';
  if (/ENOENT|not found/i.test(text)) return 'missing';
  return 'other';
}
