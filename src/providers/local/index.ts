/**
 * The local provider: the runner on this machine, through the Docker (or
 * Podman) command line, read-only, no token needed.
 *
 * - Every read (30 s): `ps -a` for the runner container and the job
 *   containers, the free space where Docker keeps its data (`statfs` of
 *   `DockerRootDir`), and now and then `info` and the cleanup timer.
 * - Rarely (30 min by default), in the background: `volume ls` and
 *   `system df -v` for the size of every volume. That walks every file of
 *   every volume and takes seconds to minutes (11-18 s for 79 volumes and
 *   60 GB on the machine this was written on), so it is never on the
 *   read's path: the read shows the last measurement and when the next is.
 *
 * The CLI rather than Docker's API socket: the same commands work for
 * Docker, rootless Docker, Podman and a remote `DOCKER_HOST`, contexts
 * included, and a command allowlist (run.ts) is easy to audit. Rootless
 * Docker is found when `DOCKER_HOST` isn't set and there's no system
 * socket but `$XDG_RUNTIME_DIR/docker.sock`.
 */
import { dirname } from 'node:path';
import { addPoint, downsample, fullInDays, growthOf, DAY } from '../../history.ts';
import type { Run } from '../../run.ts';
import type { DiskSpace, LocalData, RunnerConfig, SizePoint, TimerData, VolumeSizes } from '../../types.ts';
import { parseConfigToml } from './configtoml.ts';
import { jobsOf, parseInfo, parsePs, parseSystemDfJson, parseSystemDfTable, parseVolumes, problemOf, runnersOf, summarizeVolumes, type EngineInfo, type EngineProblem } from './parse.ts';
import { readTimer } from './systemd.ts';

export interface LocalOptions {
  engine: 'auto' | 'docker' | 'podman' | 'off';
  dockerHost: string;
  runnerContainer: string;
  sizesEveryMs: number;
  cleanupTimer: string;
  timerScope: 'user' | 'system';
  configToml: string;
}

export interface StatFs {
  bsize: number;
  blocks: number;
  bavail: number;
}

export interface Saved {
  points?: SizePoint[];
  sizes?: VolumeSizes;
}

export interface Store {
  load(): Promise<Saved>;
  save(s: Saved): Promise<void>;
}

export interface LocalDeps {
  run: Run;
  os: NodeJS.Platform;
  env: Record<string, string | undefined>;
  exists: (path: string) => boolean;
  statfs: (path: string) => Promise<StatFs>;
  readFile: (path: string) => Promise<string>;
  store: Store;
  log?: (m: string) => void;
}

export const FAST_TIMEOUT_MS = 15_000;
export const SIZES_TIMEOUT_MS = 5 * 60_000;
export const INFO_EVERY_MS = 10 * 60_000;
export const TIMER_EVERY_MS = 5 * 60_000;
export const CONFIG_EVERY_MS = 10 * 60_000;
/** The first measurement waits this long after start (unless the saved one is older than the interval anyway): Kiosko starts first. */
export const FIRST_SIZES_AFTER_MS = 60_000;
/** Points shown in the sparkline: the last day. */
export const SPARK_MS = DAY;

/** The `DOCKER_HOST` to use: the option, the environment's, or the rootless socket when there is no system one. */
export function dockerEnv(o: Pick<LocalOptions, 'dockerHost'>, d: Pick<LocalDeps, 'os' | 'env' | 'exists'>): { env: Record<string, string>; host: string | null; rootlessSocket: boolean } {
  if (o.dockerHost.trim()) return { env: { DOCKER_HOST: o.dockerHost.trim() }, host: o.dockerHost.trim(), rootlessSocket: false };
  if (d.env.DOCKER_HOST) return { env: {}, host: d.env.DOCKER_HOST, rootlessSocket: /\/run\/user\/\d+\//.test(d.env.DOCKER_HOST) };
  if (d.os === 'linux' && !d.exists('/var/run/docker.sock')) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    const dirs = [d.env.XDG_RUNTIME_DIR, uid !== null ? `/run/user/${uid}` : undefined].filter(Boolean) as string[];
    for (const dir of dirs) {
      const sock = `${dir.replace(/\/+$/, '')}/docker.sock`;
      if (d.exists(sock)) return { env: { DOCKER_HOST: `unix://${sock}` }, host: `unix://${sock}`, rootlessSocket: true };
    }
  }
  return { env: {}, host: null, rootlessSocket: false };
}

/** Docker on another machine, or in the VM of Docker Desktop / podman machine: its disk isn't this machine's. */
export function isRemote(host: string | null, os: NodeJS.Platform): boolean {
  if (os !== 'linux') return true;
  return !!host && /^(tcp|ssh|http|https):\/\//i.test(host) && !/^tcp:\/\/(localhost|127\.0\.0\.1)(:|$)/i.test(host);
}

const FORMAT: Record<'docker' | 'podman', string[]> = { docker: ['--format', '{{json .}}'], podman: ['--format', 'json'] };

export class LocalReader {
  private deps: LocalDeps;
  private startedAt: number;
  private engine: 'docker' | 'podman' | null = null;
  private info: EngineInfo | null = null;
  private infoAt = -Infinity;
  private timer: TimerData | null = null;
  private timerAt = -Infinity;
  private timerKey = '';
  private config: RunnerConfig | null = null;
  private configAt = -Infinity;
  private configKey = '';
  private saved: Saved | null = null;
  private measuring = false;
  private lastTry = -Infinity;
  private inflight = new Set<Promise<unknown>>();

  constructor(deps: LocalDeps, startedAt: number) {
    this.deps = deps;
    this.startedAt = startedAt;
  }

  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  private background(p: Promise<unknown>): void {
    const q = p.catch((e) => this.deps.log?.(`runners: ${(e as Error).message}`)).finally(() => this.inflight.delete(q));
    this.inflight.add(q);
  }

  private async state(): Promise<Saved> {
    if (!this.saved) {
      try {
        this.saved = await this.deps.store.load();
      } catch {
        this.saved = {};
      }
    }
    return this.saved;
  }

  /** Runs the engine's command; with `auto`, Podman when there's no `docker`. */
  private async engineRun(o: LocalOptions, args: (e: 'docker' | 'podman') => string[], timeoutMs: number, signal?: AbortSignal) {
    const { env } = dockerEnv(o, this.deps);
    const order: ('docker' | 'podman')[] = o.engine === 'podman' ? ['podman'] : o.engine === 'docker' ? ['docker'] : this.engine ? [this.engine] : ['docker', 'podman'];
    let last: unknown;
    for (const e of order) {
      try {
        const r = await this.deps.run(e, args(e), { timeoutMs, env, ...(signal ? { signal } : {}) });
        this.engine = e;
        return { engine: e, ...r };
      } catch (err) {
        last = err;
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    throw last;
  }

  private nextSizesAt(o: LocalOptions, sizes: VolumeSizes | undefined): number {
    const base = sizes ? sizes.at + o.sizesEveryMs : this.startedAt + FIRST_SIZES_AFTER_MS;
    // After a failed try, not again for a while either.
    return Math.max(base, this.lastTry + Math.min(o.sizesEveryMs, 10 * 60_000));
  }

  private async measure(o: LocalOptions, now: () => number): Promise<void> {
    this.measuring = true;
    const t0 = now();
    this.lastTry = t0;
    try {
      const ls = await this.engineRun(o, (e) => ['volume', 'ls', ...FORMAT[e]], FAST_TIMEOUT_MS);
      const labelled = parseVolumes(ls.stdout);
      let sized = null;
      if (ls.engine === 'docker') {
        const j = await this.engineRun(o, () => ['system', 'df', '-v', '--format', '{{json .}}'], SIZES_TIMEOUT_MS);
        sized = j.code === 0 ? parseSystemDfJson(j.stdout) : null;
      }
      if (!sized) {
        const t = await this.engineRun(o, () => ['system', 'df', '-v'], SIZES_TIMEOUT_MS);
        if (t.code !== 0) throw new Error(`system df: ${t.stderr.trim().split('\n')[0]?.slice(0, 160) ?? t.code}`);
        sized = parseSystemDfTable(t.stdout);
      }
      if (!sized) throw new Error('system df -v: no volume table');
      const at = now();
      const sizes = summarizeVolumes(sized, labelled, at, at - t0);
      const s = await this.state();
      s.sizes = sizes;
      s.points = addPoint(s.points ?? [], { at, bytes: sizes.total.bytes });
      await this.deps.store.save(s);
      this.deps.log?.(`runners: ${sizes.total.count} runner volumes, ${Math.round(sizes.total.bytes / 1e6)} MB, measured in ${Math.round(sizes.tookMs / 100) / 10} s`);
    } finally {
      this.measuring = false;
    }
  }

  private async disk(path: string | null): Promise<DiskSpace | null> {
    if (!path) return null;
    let p = path;
    for (let i = 0; i < 12; i++) {
      try {
        const s = await this.deps.statfs(p);
        const total = s.blocks * s.bsize;
        const free = s.bavail * s.bsize;
        if (!(total > 0)) return null;
        return { path: p, totalBytes: total, freeBytes: free, freeShare: free / total };
      } catch {
        const up = dirname(p);
        if (up === p) return null;
        p = up;
      }
    }
    return null;
  }

  async read(o: LocalOptions, now: number, signal?: AbortSignal, clock: () => number = Date.now): Promise<LocalData> {
    const { host, rootlessSocket } = dockerEnv(o, this.deps);
    const remote = isRemote(host, this.deps.os);
    const s = await this.state();
    const base = (): LocalData => {
      const points = s.points ?? [];
      const growth = growthOf(points, now);
      return {
        engine: this.engine ?? (o.engine === 'podman' ? 'podman' : 'docker'),
        rootless: Boolean(this.info?.rootless || rootlessSocket),
        remote,
        serverVersion: this.info?.serverVersion ?? null,
        rootDir: this.info?.rootDir ?? null,
        runners: [],
        jobs: [],
        sizes: s.sizes ?? null,
        measuring: this.measuring,
        nextSizesAt: this.measuring ? null : this.nextSizesAt(o, s.sizes),
        history: points.filter((p) => p.at >= now - SPARK_MS),
        growth,
        disk: null,
        fullInDays: null,
        timer: this.timer,
        config: this.config,
      };
    };
    const out = base();

    // The cleanup timer and config.toml don't need the engine.
    const timerKey = `${o.cleanupTimer}|${o.timerScope}`;
    if (!o.cleanupTimer.trim()) this.timer = null;
    else if (this.deps.os === 'linux' && (timerKey !== this.timerKey || now - this.timerAt >= TIMER_EVERY_MS)) {
      this.timerKey = timerKey;
      this.timerAt = now;
      try {
        this.timer = await readTimer(this.deps.run, o.cleanupTimer.trim(), o.timerScope, { timeoutMs: FAST_TIMEOUT_MS, ...(signal ? { signal } : {}) });
      } catch (e) {
        this.timer = null;
        this.deps.log?.(`runners: systemctl: ${(e as Error).message}`);
      }
    }
    out.timer = this.timer;
    if (!o.configToml.trim()) this.config = null;
    else if (o.configToml !== this.configKey || now - this.configAt >= CONFIG_EVERY_MS) {
      this.configKey = o.configToml;
      this.configAt = now;
      try {
        this.config = parseConfigToml(await this.deps.readFile(o.configToml.trim()));
      } catch (e) {
        this.config = null;
        // The error's code only: never the file's contents.
        this.deps.log?.(`runners: config.toml not readable (${(e as NodeJS.ErrnoException).code ?? 'parse error'})`);
      }
    }
    out.config = this.config;

    let problem: EngineProblem | null = null;
    try {
      const ps = await this.engineRun(o, (e) => ['ps', '-a', ...FORMAT[e]], FAST_TIMEOUT_MS, signal);
      if (ps.code !== 0) problem = problemOf(ps.stderr);
      else {
        const cs = parsePs(ps.stdout);
        out.runners = runnersOf(cs, o.runnerContainer.trim(), now);
        out.jobs = jobsOf(cs);
      }
      out.engine = ps.engine;
    } catch (e) {
      problem = (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : problemOf((e as Error).message);
    }
    if (problem) return { ...out, error: problem };

    if (now - this.infoAt >= INFO_EVERY_MS || !this.info) {
      this.infoAt = now;
      try {
        const r = await this.engineRun(o, (e) => ['info', ...FORMAT[e]], FAST_TIMEOUT_MS, signal);
        const info = parseInfo(r.stdout);
        if (!info.error) this.info = info;
      } catch (e) {
        this.deps.log?.(`runners: info: ${(e as Error).message}`);
      }
    }
    out.rootless = Boolean(this.info?.rootless || rootlessSocket);
    out.serverVersion = this.info?.serverVersion ?? null;
    out.rootDir = this.info?.rootDir ?? null;
    out.disk = remote ? null : await this.disk(out.rootDir);
    out.fullInDays = out.growth.reliable ? fullInDays(out.disk?.freeBytes, out.growth.perDay) : null;

    if (!this.measuring && now >= this.nextSizesAt(o, s.sizes)) {
      this.measuring = true;
      this.background(this.measure(o, clock));
    }
    out.measuring = this.measuring;
    out.nextSizesAt = this.measuring ? null : this.nextSizesAt(o, s.sizes);
    return out;
  }

  /** For the sparkline: the last day in `n` slices. */
  static spark(d: LocalData, n: number, now: number): (number | null)[] {
    return downsample(d.history, n, now - SPARK_MS, now);
  }
}
