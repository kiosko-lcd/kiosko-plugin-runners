/**
 * The `runners/runners` source: the runner on this machine through Docker
 * or Podman (every 30 s; the volume sizes every 30 min, in the
 * background), and, when set up, GitLab's API, GitHub's and the runner's
 * Prometheus metrics. One monitor per data folder, kept between reads; the
 * size history lives in that folder (`history.json`).
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHttp, defineSource, t } from '@kiosko/sdk';
import { runnerAlerts } from './alerts.ts';
import { demoData } from './demo.ts';
import { L } from './i18n.ts';
import { Monitor, type MonitorOptions } from './monitor.ts';
import type { Saved, Store } from './providers/local/index.ts';
import { execRun } from './run.ts';
import type { RunnersData } from './types.ts';

export const VERSION = '0.1.0';
export const AGENT = `kiosko-plugin-runners/${VERSION}`;

const MIN = 60_000;
const HOUR = 60 * MIN;

export const sourceOptions = t.object({
  engine: t.enum(['auto', 'docker', 'podman', 'off'] as const, {
    default: 'auto',
    label: L('Runner on this machine', 'Runner en este equipo', 'Runner auf diesem Rechner', '本机上的 Runner', '本機上的 Runner'),
    help: L(
      "Read with Docker's or Podman's command line, read-only (ps, volume ls, system df, info). Automatic: docker, or podman if there's no docker. Rootless Docker is found by itself.",
      'Se lee con la línea de comandos de Docker o Podman, solo lectura (ps, volume ls, system df, info). Automático: docker, o podman si no hay docker. Docker rootless se encuentra solo.',
      'Gelesen über die Kommandozeile von Docker oder Podman, nur lesend (ps, volume ls, system df, info). Automatisch: docker, oder podman, wenn es kein docker gibt. Rootless-Docker wird von selbst gefunden.',
      '通过 Docker 或 Podman 命令行只读读取（ps、volume ls、system df、info）。自动：使用 docker，没有 docker 时用 podman。会自动找到 rootless Docker。',
      '透過 Docker 或 Podman 命令列唯讀讀取（ps、volume ls、system df、info）。自動：使用 docker，沒有 docker 時用 podman。會自動找到 rootless Docker。',
    ),
    labels: {
      auto: L('Automatic', 'Automático', 'Automatisch', '自动', '自動'),
      docker: L('Docker', 'Docker', 'Docker', 'Docker', 'Docker'),
      podman: L('Podman', 'Podman', 'Podman', 'Podman', 'Podman'),
      off: L('None (only the APIs)', 'Ninguno (solo las API)', 'Keiner (nur die APIs)', '无（仅 API）', '無（僅 API）'),
    },
  }),
  sizesEveryMs: t.duration({
    default: 30 * MIN,
    min: 10 * MIN,
    max: 6 * HOUR,
    label: L('Measure the volumes every', 'Medir los volúmenes cada', 'Volumes messen alle', '测量卷的间隔', '測量磁碟區的間隔'),
    help: L(
      "`system df -v` walks every file of every volume: seconds to minutes of disk work. It runs in the background, never while Kiosko starts.",
      '`system df -v` recorre cada fichero de cada volumen: de segundos a minutos de trabajo de disco. En segundo plano, nunca mientras arranca Kiosko.',
      '`system df -v` durchläuft jede Datei jedes Volumes: Sekunden bis Minuten Plattenarbeit. Im Hintergrund, nie während Kiosko startet.',
      '`system df -v` 会遍历每个卷的每个文件：需要几秒到几分钟的磁盘操作。在后台运行，Kiosko 启动时不会运行。',
      '`system df -v` 會走訪每個磁碟區的每個檔案：需要幾秒到幾分鐘的磁碟作業。在背景執行，Kiosko 啟動時不會執行。',
    ),
  }),
  cleanupTimer: t.string({
    placeholder: 'cleanup-runner-cache.timer',
    label: L('Cleanup timer (systemd)', 'Temporizador de limpieza (systemd)', 'Bereinigungs-Timer (systemd)', '清理定时器（systemd）', '清理計時器（systemd）'),
    help: L(
      'Linux: the timer that prunes the caches, to show when it last ran and warn when it stops running. Empty: not shown.',
      'Linux: el temporizador que poda las cachés, para mostrar cuándo corrió por última vez y avisar si deja de hacerlo. Vacío: no se muestra.',
      'Linux: der Timer, der die Caches aufräumt, um zu zeigen, wann er zuletzt lief, und zu warnen, wenn er nicht mehr läuft. Leer: nicht gezeigt.',
      'Linux：清理缓存的定时器，用于显示上次运行时间，并在其停止运行时提醒。留空：不显示。',
      'Linux：清理快取的計時器，用於顯示上次執行時間，並在其停止執行時提醒。留空：不顯示。',
    ),
  }),
  timerScope: t.enum(['user', 'system'] as const, {
    default: 'user',
    advanced: true,
    label: L('Timer of', 'Temporizador de', 'Timer von', '定时器属于', '計時器屬於'),
    labels: { user: L('Your user (systemctl --user)', 'Tu usuario (systemctl --user)', 'Deinem Benutzer (systemctl --user)', '你的用户（systemctl --user）', '你的使用者（systemctl --user）'), system: L('The system', 'El sistema', 'Dem System', '系统', '系統') },
  }),
  runnerContainer: t.string({
    advanced: true,
    placeholder: 'gitlab-runner',
    label: L('Runner container', 'Contenedor del runner', 'Runner-Container', 'Runner 容器', 'Runner 容器'),
    help: L('Empty: every container of the gitlab/gitlab-runner image.', 'Vacío: todos los contenedores de la imagen gitlab/gitlab-runner.', 'Leer: alle Container des Images gitlab/gitlab-runner.', '留空：所有 gitlab/gitlab-runner 镜像的容器。', '留空：所有 gitlab/gitlab-runner 映像的容器。'),
  }),
  dockerHost: t.string({
    advanced: true,
    risk: 'network',
    placeholder: 'unix:///run/user/1000/docker.sock',
    label: L('Docker host', 'Host de Docker', 'Docker-Host', 'Docker 主机', 'Docker 主機'),
    help: L('Empty: DOCKER_HOST, the system socket, or the rootless one.', 'Vacío: DOCKER_HOST, el socket del sistema o el rootless.', 'Leer: DOCKER_HOST, der System-Socket oder der rootless.', '留空：DOCKER_HOST、系统套接字或 rootless 套接字。', '留空：DOCKER_HOST、系統通訊端或 rootless 通訊端。'),
  }),
  configToml: t.string({
    advanced: true,
    format: 'path',
    risk: 'path',
    placeholder: '/etc/gitlab-runner/config.toml',
    label: L("The runner's config.toml", 'El config.toml del runner', 'config.toml des Runners', 'Runner 的 config.toml', 'Runner 的 config.toml'),
    help: L(
      "Optional: concurrent and listen_address (for the metrics), and each runner's name and executor. Its tokens are never read into the plugin, shown or logged.",
      'Opcional: concurrent y listen_address (para las métricas), y el nombre y executor de cada runner. Sus tokens nunca se guardan en el plugin, ni se muestran ni se registran.',
      'Optional: concurrent und listen_address (für die Metriken) sowie Name und Executor jedes Runners. Seine Tokens werden nie übernommen, gezeigt oder protokolliert.',
      '可选：concurrent 和 listen_address（用于指标），以及每个 Runner 的名称和执行器。其中的令牌绝不会被插件保留、显示或记录。',
      '選用：concurrent 和 listen_address（用於指標），以及每個 Runner 的名稱和執行器。其中的權杖絕不會被外掛保留、顯示或記錄。',
    ),
  }),
  gitlabToken: t.string({
    secret: true,
    label: L('GitLab access token', 'Token de acceso de GitLab', 'GitLab-Zugriffstoken', 'GitLab 访问令牌', 'GitLab 存取權杖'),
    help: L(
      'Optional, with read_api: runner status (online, last contact, version) and the jobs waiting and running in the projects below. No admin rights needed.',
      'Opcional, con read_api: el estado de los runners (en línea, último contacto, versión) y los trabajos en cola y en marcha en los proyectos de abajo. No hace falta ser administrador.',
      'Optional, mit read_api: Runner-Status (online, letzter Kontakt, Version) und die wartenden und laufenden Jobs in den Projekten unten. Keine Admin-Rechte nötig.',
      '可选，需 read_api：Runner 状态（在线、上次联系、版本）以及下方项目中排队和运行中的作业。不需要管理员权限。',
      '選用，需 read_api：Runner 狀態（線上、上次聯絡、版本）以及下方專案中排隊和執行中的作業。不需要管理員權限。',
    ),
  }),
  gitlabUrl: t.string({ format: 'url', risk: 'network', placeholder: 'https://gitlab.com', label: L('GitLab address', 'Dirección de GitLab', 'GitLab-Adresse', 'GitLab 地址', 'GitLab 位址'), help: L('Empty: gitlab.com.', 'Vacío: gitlab.com.', 'Leer: gitlab.com.', '留空：gitlab.com。', '留空：gitlab.com。') }),
  gitlabProjects: t.list(t.string({ placeholder: 'group/project' }), { max: 20, label: L('GitLab projects', 'Proyectos de GitLab', 'GitLab-Projekte', 'GitLab 项目', 'GitLab 專案'), help: L('Their pending and running jobs. Path or id, one per line.', 'Sus trabajos en cola y en marcha. Ruta o id, uno por línea.', 'Ihre wartenden und laufenden Jobs. Pfad oder ID, eines pro Zeile.', '其排队和运行中的作业。路径或 ID，每行一个。', '其排隊和執行中的作業。路徑或 ID，每行一個。') }),
  gitlabGroups: t.list(t.string({ placeholder: 'group' }), { max: 5, advanced: true, label: L('GitLab groups', 'Grupos de GitLab', 'GitLab-Gruppen', 'GitLab 群组', 'GitLab 群組'), help: L('Their 20 most recently active projects.', 'Sus 20 proyectos con actividad más reciente.', 'Ihre 20 zuletzt aktiven Projekte.', '其最近活跃的 20 个项目。', '其最近活躍的 20 個專案。') }),
  githubToken: t.string({
    secret: true,
    label: L('GitHub token', 'Token de GitHub', 'GitHub-Token', 'GitHub 令牌', 'GitHub 權杖'),
    help: L(
      'Optional: self-hosted runners (Administration: read on a repository, Self-hosted runners: read on an organisation) and queued runs (Actions: read).',
      'Opcional: runners propios (Administration: read en un repositorio, Self-hosted runners: read en una organización) y ejecuciones en cola (Actions: read).',
      'Optional: selbst gehostete Runner (Administration: read im Repository, Self-hosted runners: read in einer Organisation) und wartende Läufe (Actions: read).',
      '可选：自托管 Runner（仓库需 Administration: read，组织需 Self-hosted runners: read）及排队的运行（Actions: read）。',
      '選用：自架 Runner（儲存庫需 Administration: read，組織需 Self-hosted runners: read）及排隊的執行（Actions: read）。',
    ),
  }),
  githubRepos: t.list(t.string({ placeholder: 'owner/repo' }), { max: 10, label: L('GitHub repositories', 'Repositorios de GitHub', 'GitHub-Repositorys', 'GitHub 仓库', 'GitHub 儲存庫') }),
  githubOrgs: t.list(t.string({ placeholder: 'my-org' }), { max: 5, advanced: true, label: L('GitHub organisations', 'Organizaciones de GitHub', 'GitHub-Organisationen', 'GitHub 组织', 'GitHub 組織') }),
  githubApi: t.string({ advanced: true, format: 'url', risk: 'network', placeholder: 'https://api.github.com', label: L('GitHub API address', 'Dirección de la API de GitHub', 'GitHub-API-Adresse', 'GitHub API 地址', 'GitHub API 位址'), help: L('Enterprise Server: https://github.example.com/api/v3.', 'Enterprise Server: https://github.example.com/api/v3.', 'Enterprise Server: https://github.example.com/api/v3.', 'Enterprise Server：https://github.example.com/api/v3。', 'Enterprise Server：https://github.example.com/api/v3。') }),
  metricsUrl: t.string({
    format: 'url',
    risk: 'network',
    placeholder: 'http://127.0.0.1:9252/metrics',
    label: L('Runner metrics address', 'Dirección de las métricas del runner', 'Adresse der Runner-Metriken', 'Runner 指标地址', 'Runner 指標位址'),
    help: L("Optional, when listen_address is set in its config.toml. Empty: from the config.toml above, if set.", 'Opcional, si tiene listen_address en su config.toml. Vacío: la del config.toml de arriba, si está puesto.', 'Optional, wenn listen_address in seiner config.toml steht. Leer: aus der config.toml oben, falls gesetzt.', '可选，需在其 config.toml 中设置 listen_address。留空：使用上方 config.toml 中的设置（如有）。', '選用，需在其 config.toml 中設定 listen_address。留空：使用上方 config.toml 中的設定（如有）。'),
  }),
  alerts: t.boolean({
    default: true,
    label: L('Full-screen alerts', 'Avisos a pantalla completa', 'Vollbild-Warnungen', '全屏提醒', '全螢幕提醒'),
    help: L(
      'Runner down or restarting, the disk below the share below, caches growing too fast, a job waiting too long, the cleanup not run.',
      'Runner parado o reiniciándose, el disco por debajo del porcentaje de abajo, cachés que crecen demasiado, un trabajo que espera demasiado, la limpieza sin correr.',
      'Runner gestoppt oder im Neustart, die Platte unter dem Anteil unten, zu schnell wachsende Caches, ein Job, der zu lange wartet, die Bereinigung nicht gelaufen.',
      'Runner 停止或重启、磁盘低于下方比例、缓存增长过快、作业等待过久、清理未运行。',
      'Runner 停止或重新啟動、磁碟低於下方比例、快取增長過快、作業等待過久、清理未執行。',
    ),
  }),
  diskFreeMinPct: t.integer({ default: 15, min: 1, max: 50, unit: '%', label: L('Critical under this much free disk', 'Crítico por debajo de este disco libre', 'Kritisch unter so viel freiem Platz', '可用磁盘低于此值为严重', '可用磁碟低於此值為嚴重') }),
  growthMaxGb: t.integer({ default: 20, min: 1, max: 2000, unit: 'GB', label: L('Warn when caches grow more than, a day', 'Avisar si las cachés crecen más de, al día', 'Warnen, wenn Caches pro Tag mehr wachsen als', '缓存每天增长超过此值时提醒', '快取每天增長超過此值時提醒') }),
  pendingMaxMs: t.duration({ default: 15 * MIN, min: MIN, max: 24 * HOUR, label: L('Warn when a job waits longer than', 'Avisar si un trabajo espera más de', 'Warnen, wenn ein Job länger wartet als', '作业等待超过此时长时提醒', '作業等待超過此時長時提醒') }),
  timerMaxMs: t.duration({ default: 26 * HOUR, min: HOUR, max: 14 * 24 * HOUR, advanced: true, label: L('Warn when the cleanup has not run for', 'Avisar si la limpieza no ha corrido en', 'Warnen, wenn die Bereinigung nicht gelaufen ist seit', '清理超过此时长未运行时提醒', '清理超過此時長未執行時提醒') }),
});

export const fileStore = (dir: string): Store => {
  const file = join(dir, 'history.json');
  return {
    async load() {
      try {
        return JSON.parse(await readFile(file, 'utf8')) as Saved;
      } catch {
        return {};
      }
    },
    async save(s) {
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(file, JSON.stringify(s));
      } catch {
        /* kept in memory */
      }
    },
  };
};

const monitors = new Map<string, Monitor>();
const http = createHttp({ agent: AGENT });

export const runnersSource = defineSource({
  id: 'runners',
  name: L('CI runners', 'Runners de CI', 'CI-Runner', 'CI Runner', 'CI Runner'),
  description: L(
    "The GitLab runner on this machine through Docker or Podman (read-only): its container, the jobs running, its cache volumes' size and growth, the free disk and the cleanup timer; and, if set up, runner status and waiting jobs from GitLab's API, GitHub Actions self-hosted runners and the runner's Prometheus metrics.",
    'El runner de GitLab de este equipo a través de Docker o Podman (solo lectura): su contenedor, los trabajos en marcha, el tamaño y el crecimiento de sus volúmenes de caché, el disco libre y el temporizador de limpieza; y, si se configuran, el estado de los runners y los trabajos en cola de la API de GitLab, los runners propios de GitHub Actions y las métricas Prometheus del runner.',
    'Der GitLab-Runner auf diesem Rechner über Docker oder Podman (nur lesend): sein Container, die laufenden Jobs, Größe und Wachstum seiner Cache-Volumes, der freie Platz und der Bereinigungs-Timer; und, wenn eingerichtet, Runner-Status und wartende Jobs aus der GitLab-API, selbst gehostete GitHub-Actions-Runner und die Prometheus-Metriken des Runners.',
    '通过 Docker 或 Podman（只读）读取本机上的 GitLab Runner：其容器、运行中的作业、缓存卷的大小和增长、可用磁盘和清理定时器；如已设置，还包括 GitLab API 中的 Runner 状态和排队作业、GitHub Actions 自托管 Runner，以及 Runner 的 Prometheus 指标。',
    '透過 Docker 或 Podman（唯讀）讀取本機上的 GitLab Runner：其容器、執行中的作業、快取磁碟區的大小和增長、可用磁碟和清理計時器；如已設定，還包括 GitLab API 中的 Runner 狀態和排隊作業、GitHub Actions 自架 Runner，以及 Runner 的 Prometheus 指標。',
  ),
  options: sourceOptions,
  intervalMs: 30_000,
  minIntervalMs: 15_000,
  timeoutMs: 40_000,
  background: true,
  async read(ctx): Promise<RunnersData> {
    let m = monitors.get(ctx.dataDir);
    if (!m) {
      const deps = { run: execRun, os: process.platform, env: process.env, exists: existsSync, statfs, readFile: (p: string) => readFile(p, 'utf8'), store: fileStore(ctx.dataDir), log: (s: string) => ctx.log(s) };
      monitors.set(ctx.dataDir, (m = new Monitor({ local: deps, http, log: (s) => ctx.log(s) }, ctx.now)));
    }
    return m.sample(ctx.options as unknown as MonitorOptions, ctx.now, ctx.signal);
  },
  demo: ({ now }) => demoData(now),
  alerts: ({ data, now }) => runnerAlerts(data, now),
});
