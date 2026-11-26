# Fixtures

Command outputs and API answers the parsers are tested against.

- `docker-*`, `podman-*`: the shapes of `ps -a`, `volume ls`, `system df -v`
  (Docker's JSON and table forms, Podman's table) and `info` (rootless,
  rootful, daemon down), modelled on real output of Docker 29 (rootless)
  and Podman 5, with made-up names, ids and sizes.
- `systemctl-show-*`: `systemctl --user show` of a timer and its service,
  with `--timestamp=unix` and in the older written form, and a unit that
  does not exist.
- `config.toml`: a synthetic gitlab-runner config with **fake** tokens,
  passwords and keys. The tests check that none of them ever comes out of
  the parser.
- `metrics.txt`: gitlab-runner's Prometheus endpoint, with the metric names
  and labels of gitlab-runner 19.
- `gitlab-*`, `github-*`: answers in the shapes documented at
  docs.gitlab.com/api/runners, /api/jobs and docs.github.com/rest/actions;
  not recorded from a real account.

Compared byte for byte: `.gitattributes` keeps Git from changing their line endings.
