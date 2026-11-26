## Where it reads from

| Provider | Needs | What it gives | How often |
|---|---|---|---|
| **This machine** (Docker or Podman) | Nothing: the `docker` or `podman` command | The runner container (up, restarting, down; version; uptime), the jobs running now (from their containers' labels), the runner volumes' count and size split into cache / builds and protected / not, their growth a day, the free space where Docker keeps its data and when it's full at that pace | Every 30 s; the sizes every 30 min |
| **Cleanup timer** (Linux) | Its name in the options | When it last ran and whether it worked | Every 5 min |
| **GitLab API** | A token with `read_api` | Each runner's status (online, offline, stale, paused), last contact and version; the jobs pending and running in the projects (or groups) you list, and how long the oldest has waited | Every 2 min |
| **GitHub Actions** | A token (see below) | Self-hosted runners (online, busy, labels); queued and running workflow runs | Every 2 min |
| **Runner metrics** | `listen_address` in the runner's `config.toml` | Version, `concurrent`, jobs running, totals | Every minute |

## Read-only, and how that is enforced

The plugin only looks. Every program it runs goes through one function
(`src/run.ts`) that checks the whole command against a list before
anything is spawned:

- `docker` / `podman`: `ps`, `container ls`, `volume ls`, `system df`,
  `info`, `version`, with `--format`, `--filter`, `--all`, `--verbose`,
  `--no-trunc`, `--quiet` and nothing else (no names, no `-H`, no `--config`);
- `systemctl`: `show` and `list-timers` of `.timer` / `.service` units.

`prune`, `rm`, `stop`, `start`, `create`, `exec`, `cp`, `systemctl start`…
are refused there, and the tests assert that each of them never reaches the
process spawner. Cleaning up stays your job (see below); the plugin tells
you when it's due.

**Rootless Docker** is found on its own: when `DOCKER_HOST` isn't set and
there's no `/var/run/docker.sock` but `$XDG_RUNTIME_DIR/docker.sock` exists,
that socket is used. Its data lives in your home
(`~/.local/share/docker`), usually on the system disk: the free space shown
is that of the filesystem holding Docker's `DockerRootDir`, measured with
`statfs` (walking up to the nearest folder the plugin may look at). With
Docker on another machine (`tcp://`, `ssh://`) or in a VM (Docker Desktop,
`podman machine`) that disk isn't this machine's, and the widget says so.

**Why the command line and not Docker's API socket**: the same few commands
work for Docker, rootless Docker, Podman and a remote `DOCKER_HOST` or
context, and an allowlist of commands is easy to read and audit.

**Why sizes every 30 minutes**: `docker system df -v` walks every file of
every volume. On the machine this was written on (rootless Docker, 79
volumes, 62 of them the runner's, 29 GB) it took 11-18 s, and even plain
`docker system df` 10.7 s. It runs in the background, never while Kiosko
starts (the first one a minute after), never twice at once, and the widgets
show the last measurement and its age. You can set it from 10 minutes to 6
hours.

**Growth** counts only what was added between measurements over the last
day: a nightly cleanup makes the total drop, and the net change would hide
how fast the jobs fill the disk. It needs two hours of history; the history
(sizes only, a week at most) is kept in the plugin's data folder.

## Tokens

- **GitLab**: a personal (or project/group) access token with `read_api`.
  No admin rights: it uses `GET /runners` (the runners you can manage),
  `GET /runners/:id` and `/runners/:id/managers`, and
  `GET /projects/:id/jobs?scope[]=pending&scope[]=running` for the projects
  you list (a group: its 20 most recently active projects). Self-managed
  GitLab: its address in the options.
- **GitHub**: a fine-grained token with *Administration: read* on the
  repositories (for their runners) and *Actions: read* (for the runs), or
  *Self-hosted runners: read* on an organisation. Without admin rights on a
  repository, its runs still count. GitHub Enterprise Server: its API
  address.
- Both are stored as secrets by Kiosko (masked in the editor, never
  logged), sent only as headers to the host you set, and an error is shown
  as a short word (`unauthorized`), never with the token or URL.

**The runner's `config.toml`** (optional, advanced): when you set its path,
the plugin reads `concurrent`, `listen_address` and each runner's name,
GitLab host and executor, keeping only those keys (an allowlist) and
dropping user and password from URLs. The runner tokens, the cache's S3
keys and anything else in the file are never kept, shown or logged. The
file is usually readable only by root; you don't need it for anything but
the metrics address and the `2/4` jobs figure.

## Alerts

On by default (the switch in the source's options):

| When | Level |
|---|---|
| Docker (or Podman) doesn't answer | critical |
| The runner container is down, or unhealthy | critical |
| The runner container keeps restarting | warning |
| The disk holding Docker's data under 15 % free | critical, with when it's full |
| The caches grow more than 20 GB a day | warning |
| A job waits for a runner more than 15 min (GitLab or GitHub API) | warning |
| GitLab or GitHub sees a runner offline | warning |
| The cleanup timer hasn't run in 26 h, or its last run failed | warning |

Thresholds are in the source's options. Each alert shows once per
episode (the container, the day, the oldest job).

## The runner-cache problem, and cleaning up

With the Docker executor, GitLab Runner keeps a volume per project,
concurrency slot and protection level for `/cache` (`cache:` of the jobs)
and, unless `builds_dir` is a bind mount, another for `/builds` (the
clone): `runner-<id>-project-<n>-concurrent-<k>-cache-<md5 of the
path>[-protected]`. Nothing ever deletes them. A busy runner with
`node_modules`, `.m2`, `target/` or Docker layers in its cache can add tens
of gigabytes a day, until the disk is full and every job (and anything else
on that disk) fails. With rootless Docker that disk is usually the system
one, under your home.

What helps, roughly from least to most work:

1. **Prune the runner's volumes on a timer.** They carry the label
   `com.gitlab.gitlab-runner.managed=true`; volumes in use by a running job
   aren't removed:

   ```sh
   docker volume prune -f --filter label=com.gitlab.gitlab-runner.managed=true
   ```

   As a systemd user timer (`~/.config/systemd/user/cleanup-runner-cache.{service,timer}`):

   ```ini
   # cleanup-runner-cache.service
   [Service]
   Type=oneshot
   ExecStart=/usr/bin/docker volume prune -f --filter label=com.gitlab.gitlab-runner.managed=true

   # cleanup-runner-cache.timer
   [Timer]
   OnCalendar=*-*-* 03:30
   RandomizedDelaySec=30m
   Persistent=true
   [Install]
   WantedBy=timers.target
   ```

   `systemctl --user enable --now cleanup-runner-cache.timer` (and
   `loginctl enable-linger $USER` so it runs while you're logged out), then
   put `cleanup-runner-cache` in the plugin's *Cleanup timer* option: the
   widget shows when it last ran, and an alert says when it stops.
   GitLab also ships `clear-docker-cache` in the runner package, which
   does the same with a few more options.
2. **Prune images and build cache too**: `docker image prune -af --filter
   until=72h` and `docker builder prune -af --filter until=72h`, for jobs
   that build images.
3. **Cache less.** A `cache:key` per branch multiplies volumes; per
   lockfile (`key: files: [package-lock.json]`) keeps them few. `policy:
   pull` on the jobs that only read it. Clean `/builds` with `GIT_CLEAN_FLAGS`
   / `GIT_STRATEGY: fetch`.
4. **Disable the local cache volume** (`disable_cache = true` under
   `[runners.docker]`) and use a distributed cache (S3, GCS) whose
   lifecycle rules expire old objects.
5. **Move Docker's data** off the system disk (`data-root` in
   `daemon.json`; for rootless, `~/.config/docker/daemon.json`).

The plugin never does any of this itself.
