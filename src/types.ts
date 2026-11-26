/** What the source hands to the widgets: plain data, the same on every system. */

/** A count and the bytes it adds up to. */
export interface Tally {
  count: number;
  bytes: number;
}

/** A container running gitlab-runner itself (not a job). */
export interface RunnerContainer {
  name: string;
  image: string;
  /** The image tag when it looks like a version (`v19.5.1` → `19.5.1`). */
  version: string | null;
  /** As Docker or Podman says it: `running`, `restarting`, `exited`, `paused`, `created`, `dead`. */
  state: string;
  /** `healthy`, `unhealthy`, `starting`, or null without a health check. */
  health: string | null;
  /** When it was created, epoch ms (null when unknown). */
  createdAt: number | null;
  /** When it last started, epoch ms: from "Up 10 days" (Docker) or `StartedAt` (Podman). */
  startedAt: number | null;
  /** Docker's own words: "Up 10 days", "Restarting (1) 5 seconds ago". */
  status: string;
}

/** A CI job running now in a container on this machine, from its labels. */
export interface LocalJob {
  id: string;
  /** Last part of the project path (`web`), from the job's URL label; null when there is none. */
  project: string | null;
  ref: string | null;
  /** `build` (the job's script) or `service`; helper containers are left out. */
  kind: string;
  startedAt: number | null;
}

/** The runner-managed volumes, as `docker system df -v` measured them. */
export interface VolumeSizes {
  at: number;
  /** How long the measuring took, ms (it is slow: it walks every volume). */
  tookMs: number;
  total: Tally;
  /** Mounted at /cache: `cache:` of the jobs. */
  cache: Tally;
  /** Mounted at /builds: the clones of the repositories. */
  builds: Tally;
  /** For protected branches and tags (`-protected`), whichever the kind. */
  protected: Tally;
  unprotected: Tally;
  /** Volumes Docker keeps that the runner did not make. */
  other: Tally;
  /** The biggest single runner volume, bytes. */
  largest: number;
}

/** One measurement kept for the growth figures. */
export interface SizePoint {
  at: number;
  bytes: number;
}

export interface Growth {
  /** Bytes the caches grew per day, counting only increases (a cleanup does not hide the pace). Null with too little history. */
  perDay: number | null;
  /** Bytes per day, net of cleanups, over the same span. */
  netPerDay: number | null;
  /** How much history the figures rest on, ms. */
  spanMs: number;
  /** Bytes added (increases only) over `spanMs`: what is shown before the rate is reliable. */
  added: number;
  /** Enough history (12 h) for a rate a day and a projection; before that one big job would read as tens of GB a day. */
  reliable: boolean;
}

export interface DiskSpace {
  /** The path measured (Docker's root dir, or the nearest folder above it the plugin may look at). */
  path: string;
  totalBytes: number;
  freeBytes: number;
  /** freeBytes / totalBytes. */
  freeShare: number;
}

export interface TimerData {
  unit: string;
  found: boolean;
  /** `active`, `inactive`, `failed`… */
  state: string | null;
  lastAt: number | null;
  nextAt: number | null;
  /** The service's last result: `success`, `exit-code`… */
  result: string | null;
  exitStatus: number | null;
}

/** What the plugin keeps of the runner's config.toml (never a token: see providers/local/configtoml.ts). */
export interface RunnerConfig {
  concurrent: number | null;
  listenAddress: string | null;
  runners: { name: string; url: string; executor: string; limit: number | null; disableCache: boolean | null }[];
}

export interface LocalData {
  engine: 'docker' | 'podman';
  rootless: boolean;
  /** Docker on another machine (tcp://, ssh://) or in a VM (Docker Desktop): its disk can't be measured from here. */
  remote: boolean;
  serverVersion: string | null;
  rootDir: string | null;
  /** Why the engine can't be read ("not running", "permission denied"); the rest is then empty. */
  error?: string;
  runners: RunnerContainer[];
  jobs: LocalJob[];
  sizes: VolumeSizes | null;
  /** A measurement is under way (it takes seconds to minutes). */
  measuring: boolean;
  nextSizesAt: number | null;
  /** The last days of sizes, oldest first, for the sparkline. */
  history: SizePoint[];
  growth: Growth;
  disk: DiskSpace | null;
  /** Days until the disk is full at the current growth; null when it isn't growing or can't be told. */
  fullInDays: number | null;
  timer: TimerData | null;
  /** From config.toml, when its path is set. */
  config: RunnerConfig | null;
}

export type ApiRunnerStatus = 'online' | 'offline' | 'paused' | 'stale' | 'never_contacted';

export interface ApiRunner {
  id: string;
  name: string;
  status: ApiRunnerStatus;
  /** Running a job (GitHub's `busy`; GitLab: when it has a running job in the projects read). */
  busy: boolean | null;
  contactedAt: number | null;
  version: string | null;
  labels: string[];
}

export interface ApiJob {
  id: string;
  project: string;
  name: string;
  status: 'pending' | 'running' | 'queued' | 'in_progress';
  createdAt: number | null;
  startedAt: number | null;
}

export interface ApiData {
  at: number;
  error?: string;
  runners: ApiRunner[];
  pending: number;
  running: number;
  /** When the oldest job still waiting for a runner was created, epoch ms. */
  oldestPendingAt: number | null;
  jobs: ApiJob[];
}

export interface MetricsData {
  at: number;
  error?: string;
  version: string | null;
  /** `concurrent` in config.toml: how many jobs at once at most. */
  concurrent: number | null;
  /** Jobs running now, over every runner of the process. */
  running: number;
  jobsTotal: number | null;
  failedTotal: number | null;
  errorsTotal: number | null;
  /** Since when the process runs, epoch ms. */
  startedAt: number | null;
}

export interface Thresholds {
  /** Disk holding Docker: free share under which it is critical (0..1). */
  diskFreeMin: number;
  /** Bytes a day of cache growth that is too fast. */
  growthMax: number;
  /** A job waiting for a runner for longer than this, ms. */
  pendingMaxMs: number;
  /** The cleanup timer not run for longer than this, ms. */
  timerMaxMs: number;
}

export interface AlertSettings {
  enabled: boolean;
}

export interface RunnersData {
  at: number;
  /** Null when the local provider is off. */
  local: LocalData | null;
  gitlab: ApiData | null;
  github: ApiData | null;
  metrics: MetricsData | null;
  thresholds: Thresholds;
  alerts: AlertSettings;
  demo?: boolean;
}
