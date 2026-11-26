import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execRun, guard, isReadOnly, NotAllowed, type Run } from './run.ts';

const READ_ONLY: [string, string[]][] = [
  ['docker', ['ps', '-a', '--format', '{{json .}}']],
  ['docker', ['volume', 'ls', '--format', '{{json .}}']],
  ['docker', ['volume', 'ls', '--filter', 'label=com.gitlab.gitlab-runner.managed=true', '-q']],
  ['docker', ['system', 'df', '-v', '--format', '{{json .}}']],
  ['docker', ['system', 'df', '-v']],
  ['docker', ['info', '--format={{json .}}']],
  ['docker', ['version']],
  ['docker', ['container', 'ls', '--all', '--no-trunc']],
  ['podman', ['ps', '-a', '--format', 'json']],
  ['podman', ['info', '--format', 'json']],
  ['systemctl', ['--user', 'show', '--no-pager', '--timestamp=unix', '-p', 'Id,LastTriggerUSec', 'cleanup-runner-cache.timer']],
  ['systemctl', ['show', '--property=Result,ExecMainStatus', 'cleanup.service']],
  ['systemctl', ['--user', 'list-timers', '--all', '--no-pager', '--output=json']],
];

const MUTATING: [string, string[]][] = [
  ['docker', ['volume', 'prune', '-f']],
  ['docker', ['volume', 'prune', '--filter', 'label=com.gitlab.gitlab-runner.managed=true']],
  ['docker', ['volume', 'rm', 'runner-abc-cache-3c3f060a0374fc8bc39395164f415a70']],
  ['docker', ['volume', 'create', 'x']],
  ['docker', ['system', 'prune', '-af', '--volumes']],
  ['docker', ['builder', 'prune']],
  ['docker', ['image', 'prune', '-a']],
  ['docker', ['container', 'prune']],
  ['docker', ['rm', '-f', 'gitlab-runner']],
  ['docker', ['stop', 'gitlab-runner']],
  ['docker', ['restart', 'gitlab-runner']],
  ['docker', ['kill', 'gitlab-runner']],
  ['docker', ['exec', 'gitlab-runner', 'gitlab-runner', 'unregister', '--all-runners']],
  ['docker', ['run', '--rm', 'alpine', 'rm', '-rf', '/']],
  ['docker', ['start', 'x']],
  ['docker', ['create', 'alpine']],
  ['docker', ['cp', 'gitlab-runner:/etc/gitlab-runner/config.toml', '.']],
  ['docker', ['volume', 'inspect', 'x']],
  // A read-only subcommand with a word after it, or a flag not on the list.
  ['docker', ['ps', 'rm']],
  ['docker', ['ps', '-a', 'gitlab-runner']],
  ['docker', ['-H', 'tcp://evil:2375', 'ps']],
  ['docker', ['--config', '/tmp/x', 'ps']],
  ['docker', ['system', 'df', '--format']],
  ['docker', ['system', 'dial-stdio']],
  ['docker', ['context', 'use', 'rootless']],
  ['docker', []],
  ['podman', ['volume', 'prune', '-f']],
  ['podman', ['system', 'reset', '-f']],
  ['podman', ['system', 'prune', '-a']],
  ['systemctl', ['--user', 'start', 'cleanup-runner-cache.service']],
  ['systemctl', ['--user', 'stop', 'cleanup-runner-cache.timer']],
  ['systemctl', ['--user', 'disable', '--now', 'cleanup-runner-cache.timer']],
  ['systemctl', ['--user', 'restart', 'docker.service']],
  ['systemctl', ['--user', 'daemon-reload']],
  ['systemctl', ['--user', 'show', '-p', 'Id;rm -rf', 'x.timer']],
  ['systemctl', ['--user', 'show', '../../etc/passwd']],
  ['systemctl', ['--user', 'show', '--host=root@elsewhere', 'x.timer']],
  ['systemctl', ['--user']],
  ['sh', ['-c', 'docker ps']],
  ['rm', ['-rf', '/home/u/.local/share/docker/volumes']],
  ['gitlab-runner', ['list']],
  ['du', ['-sh', '/home/u/.local/share/docker']],
];

test('read-only commands are allowed', () => {
  for (const [cmd, args] of READ_ONLY) assert.ok(isReadOnly(cmd, args), `${cmd} ${args.join(' ')}`);
});

test('nothing that changes anything (or could) is allowed', () => {
  for (const [cmd, args] of MUTATING) assert.equal(isReadOnly(cmd, args), false, `${cmd} ${args.join(' ')}`);
});

test('the guard refuses before spawning: the wrapped runner is never called', async () => {
  const called: string[] = [];
  const spy: Run = async (cmd, args) => (called.push([cmd, ...args].join(' ')), { stdout: '', stderr: '', code: 0 });
  const run = guard(spy);
  for (const [cmd, args] of MUTATING) await assert.rejects(run(cmd, args, { timeoutMs: 1000 }), NotAllowed, `${cmd} ${args.join(' ')}`);
  assert.deepEqual(called, []);
  await run('docker', ['ps', '-a'], { timeoutMs: 1000 });
  assert.deepEqual(called, ['docker ps -a']);
});

test('the real runner is guarded too: a prune is refused without running docker', async () => {
  await assert.rejects(execRun('docker', ['volume', 'prune', '-f'], { timeoutMs: 1000 }), NotAllowed);
  await assert.rejects(execRun('systemctl', ['--user', 'start', 'x.service'], { timeoutMs: 1000 }), NotAllowed);
});
