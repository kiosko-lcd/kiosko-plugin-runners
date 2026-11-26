/**
 * The runner's `config.toml`, when you point the plugin at it (off by
 * default): how many jobs it runs at once, where its Prometheus metrics
 * listen, and the name, GitLab host and executor of each runner in it.
 *
 * The file holds every runner's authentication token. This reader keeps
 * only the keys listed below (an allowlist: a key it doesn't know is
 * dropped, whatever its name), strips user and password from URLs, and
 * never quotes the file in an error. Nothing else of it is kept, logged or
 * handed to the widgets.
 */
import type { RunnerConfig } from '../../types.ts';

const GLOBAL_KEYS = new Set(['concurrent', 'check_interval', 'listen_address', 'log_level']);
const RUNNER_KEYS = new Set(['name', 'url', 'executor', 'limit']);
const DOCKER_KEYS = new Set(['disable_cache']);

type Value = string | number | boolean;

/** A TOML value as far as these keys need: strings (basic and literal), numbers, booleans; anything else is null. */
function value(raw: string): Value | null {
  const s = raw.trim();
  let m = /^"((?:[^"\\]|\\.)*)"/.exec(s);
  if (m) return m[1]!.replace(/\\(["\\nt])/g, (_x, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
  m = /^'([^']*)'/.exec(s);
  if (m) return m[1]!;
  if (/^(true|false)\b/.test(s)) return s.startsWith('true');
  m = /^([+-]?\d[\d_]*(?:\.\d+)?)\b/.exec(s);
  if (m) return Number(m[1]!.replace(/_/g, ''));
  return null;
}

/** `https://user:pass@gitlab.example.com/` → `https://gitlab.example.com`. */
export function cleanUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host}${x.pathname.replace(/\/+$/, '')}`;
  } catch {
    return '';
  }
}

/** `:9252`, `0.0.0.0:9252`, `[::]:9252` → `http://127.0.0.1:9252/metrics`. */
export function metricsUrlOf(listen: string): string | null {
  const m = /^(?:\[([^\]]+)\]|([^:]*)):(\d{1,5})$/.exec(listen.trim());
  if (!m) return null;
  const host = m[1] ?? m[2] ?? '';
  const h = !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  return `http://${h}:${m[3]}/metrics`;
}

export function parseConfigToml(text: string): RunnerConfig {
  const cfg: RunnerConfig = { concurrent: null, listenAddress: null, runners: [] };
  type R = RunnerConfig['runners'][number];
  let section: 'global' | 'runner' | 'docker' | 'other' = 'global';
  let cur: R | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const table = /^\[\[?\s*([A-Za-z0-9_.\-"]+)\s*\]\]?/.exec(line);
    if (table) {
      const name = table[1]!.replace(/"/g, '');
      if (line.startsWith('[[') && name === 'runners') {
        cur = { name: '', url: '', executor: '', limit: null, disableCache: null };
        cfg.runners.push(cur);
        section = 'runner';
      } else if (name === 'runners.docker' && cur) section = 'docker';
      else section = 'other';
      continue;
    }
    const kv = /^([A-Za-z0-9_\-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    if (section === 'global' && GLOBAL_KEYS.has(key)) {
      const v = value(kv[2]!);
      if (key === 'concurrent' && typeof v === 'number') cfg.concurrent = v;
      if (key === 'listen_address' && typeof v === 'string') cfg.listenAddress = v;
    } else if (section === 'runner' && cur && RUNNER_KEYS.has(key)) {
      const v = value(kv[2]!);
      if (key === 'name' && typeof v === 'string') cur.name = v.slice(0, 80);
      if (key === 'url' && typeof v === 'string') cur.url = cleanUrl(v);
      if (key === 'executor' && typeof v === 'string') cur.executor = v.slice(0, 40);
      if (key === 'limit' && typeof v === 'number') cur.limit = v;
    } else if (section === 'docker' && cur && DOCKER_KEYS.has(key)) {
      const v = value(kv[2]!);
      if (key === 'disable_cache' && typeof v === 'boolean') cur.disableCache = v;
    }
  }
  return cfg;
}
