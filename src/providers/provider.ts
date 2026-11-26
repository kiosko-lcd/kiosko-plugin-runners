/**
 * A remote provider: somewhere that knows about the runners from the
 * outside (GitLab's API, GitHub's, the runner's own metrics endpoint).
 * Each is a module here, listed in `providers/index.ts`, read by the
 * monitor every `everyMs` when its options turn it on. The local one
 * (Docker or Podman on this machine) is `providers/local`.
 */
import type { HttpClient, Localized } from '@kiosko/sdk';

/** The source's options, as every provider sees them (each reads its own). */
export interface RemoteOptions {
  gitlabUrl: string;
  gitlabToken: string;
  gitlabProjects: string[];
  gitlabGroups: string[];
  githubApi: string;
  githubToken: string;
  githubRepos: string[];
  githubOrgs: string[];
  metricsUrl: string;
}

export interface RemoteContext {
  http: HttpClient;
  now: number;
  signal?: AbortSignal;
  log?: (m: string) => void;
  /** From config.toml's `listen_address`, when the metrics address isn't set. */
  metricsFallback?: string | null;
}

export interface RemoteProvider<D> {
  id: string;
  name: Localized;
  /** Hosts it contacts by default (the plugin's `permissions.network`). */
  hosts: string[];
  enabled(o: RemoteOptions, ctx: Pick<RemoteContext, 'metricsFallback'>): boolean;
  everyMs: number;
  read(o: RemoteOptions, ctx: RemoteContext): Promise<D>;
}

/** `gitlab.example.com/` → `https://gitlab.example.com`. */
export function baseUrl(url: string, fallback: string): string {
  let u = (url || fallback).trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u.replace(/\/+$/, '');
}

export const isoMs = (v: unknown): number | null => {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/** The oldest time in a list, or null. */
export const oldest = (xs: (number | null)[]): number | null => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? Math.min(...v) : null;
};

/** Short, safe words for what went wrong, never a token or a URL with one. */
export function errorWord(e: unknown): string {
  const status = (e as { status?: number }).status;
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not found';
  if (status === 429) return 'rate limited';
  if (status) return `HTTP ${status}`;
  const name = (e as Error)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout';
  const code = (e as { cause?: { code?: string } })?.cause?.code;
  return code ? code.toLowerCase() : 'unreachable';
}
