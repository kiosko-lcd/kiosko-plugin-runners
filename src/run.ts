/**
 * Every program the plugin runs goes through `guard`: an allowlist of
 * read-only commands, checked word by word before anything is spawned.
 * The plugin looks; it never prunes, removes, stops, starts or creates
 * anything, and a command outside the list is refused here, not left to
 * the caller's good behaviour.
 *
 * Allowed:
 *
 * - `docker` / `podman`: `ps`, `container ls`, `volume ls`, `system df`,
 *   `info`, `version`, with the flags below (`--format`, `--filter`,
 *   `--all`, `--verbose`, `--no-trunc`, `--quiet`).
 * - `systemctl`: `show` and `list-timers`, for `.timer` and `.service`
 *   units, with `--user`, `-p`/`--property`, `--timestamp=unix`, `--all`,
 *   `--no-pager`, `--output=json`.
 *
 * Everything else, including a flag not in the list (Docker's `-H` would
 * send the command elsewhere, `--config` read another file), is refused.
 */
import { execFile } from 'node:child_process';

/** Runs a program; resolves with its output and exit code even when the code isn't 0. Rejects when it can't run (`ENOENT`) or times out. */
export type Run = (cmd: string, args: string[], o: { timeoutMs: number; signal?: AbortSignal; env?: Record<string, string> }) => Promise<{ stdout: string; stderr: string; code: number }>;

export class NotAllowed extends Error {
  constructor(cmd: string, args: string[]) {
    super(`not a read-only command: ${[cmd, ...args].join(' ').slice(0, 200)}`);
    this.name = 'NotAllowed';
  }
}

export const ENGINES = ['docker', 'podman'] as const;
export type Engine = (typeof ENGINES)[number];

/** Subcommands, as the words after the program. */
const ENGINE_COMMANDS = [['ps'], ['container', 'ls'], ['volume', 'ls'], ['system', 'df'], ['info'], ['version']];
/** Flags that take a value, and flags that don't. */
const ENGINE_VALUE_FLAGS = new Set(['--format', '-f', '--filter']);
const ENGINE_BOOL_FLAGS = new Set(['--all', '-a', '--verbose', '-v', '--no-trunc', '--quiet', '-q']);

const SYSTEMCTL_VERBS = new Set(['show', 'list-timers']);
const SYSTEMCTL_VALUE_FLAGS = new Set(['-p', '--property']);
const SYSTEMCTL_BOOL_FLAGS = new Set(['--user', '--timestamp=unix', '--all', '--no-pager', '--output=json', '--no-legend']);
const UNIT = /^[A-Za-z0-9@_.:-]{1,120}\.(timer|service)$/;
const PROPERTY = /^[A-Za-z]+(,[A-Za-z]+)*$/;

function engineAllowed(args: string[]): boolean {
  const cmd = ENGINE_COMMANDS.find((c) => c.every((w, i) => args[i] === w));
  if (!cmd) return false;
  const rest = args.slice(cmd.length);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    if (ENGINE_BOOL_FLAGS.has(flag) && inline === undefined) continue;
    if (ENGINE_VALUE_FLAGS.has(flag)) {
      if (inline === undefined) {
        if (i + 1 >= rest.length) return false;
        i++;
      }
      continue;
    }
    // No positional words: nothing is named, so nothing can be acted on.
    return false;
  }
  return true;
}

function systemctlAllowed(args: string[]): boolean {
  let verb: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (SYSTEMCTL_BOOL_FLAGS.has(a)) continue;
    if (SYSTEMCTL_VALUE_FLAGS.has(a)) {
      if (!PROPERTY.test(args[i + 1] ?? '')) return false;
      i++;
      continue;
    }
    if (a.startsWith('--property=')) {
      if (!PROPERTY.test(a.slice(11))) return false;
      continue;
    }
    if (a.startsWith('-')) return false;
    if (verb === null) {
      if (!SYSTEMCTL_VERBS.has(a)) return false;
      verb = a;
      continue;
    }
    if (!UNIT.test(a)) return false;
  }
  return verb !== null;
}

/** Whether a command is on the read-only list. */
export function isReadOnly(cmd: string, args: string[]): boolean {
  if ((ENGINES as readonly string[]).includes(cmd)) return engineAllowed(args);
  if (cmd === 'systemctl') return systemctlAllowed(args);
  return false;
}

/** Wraps a runner so that only read-only commands reach it; the rest throw `NotAllowed` without being spawned. */
export function guard(run: Run): Run {
  return (cmd, args, o) => {
    if (!isReadOnly(cmd, args)) return Promise.reject(new NotAllowed(cmd, args));
    return run(cmd, args, o);
  };
}

const spawnRun: Run = (cmd, args, { timeoutMs, signal, env }) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'utf8', ...(signal ? { signal } : {}), env: { ...process.env, ...env, LC_ALL: 'C', LANG: 'C' } },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: unknown }) | null;
        if (e && (typeof e.code !== 'number' || e.killed)) return reject(e);
        resolve({ stdout: String(stdout), stderr: String(stderr), code: e ? (e.code as unknown as number) : 0 });
      },
    );
  });

/** The only runner the plugin uses on a real machine: the system's programs, behind the allowlist. */
export const execRun: Run = guard(spawnRun);
