/**
 * Your CI runners on the panel: whether the GitLab runner container is up
 * and the jobs it runs, what its cache volumes cost on disk and how fast
 * they grow, the free space left where Docker keeps them and when it runs
 * out, and when the cleanup last ran; optionally runner status and waiting
 * jobs from GitLab's API, GitHub Actions self-hosted runners and the
 * runner's Prometheus metrics. Read-only: it never prunes or stops anything.
 */
import { definePlugin } from '@kiosko/sdk';
import { L, LANGUAGES } from './i18n.ts';
import { REMOTE_HOSTS } from './providers/index.ts';
import { runnersSource, VERSION } from './source.ts';
import { cache } from './widget-cache.ts';
import { compact } from './widget-compact.ts';
import { now } from './widget-now.ts';

export { runnersSource } from './source.ts';
export { cache } from './widget-cache.ts';
export { compact } from './widget-compact.ts';
export { now } from './widget-now.ts';

export default definePlugin({
  id: 'runners',
  name: L('CI runners', 'Runners de CI', 'CI-Runner', 'CI Runner', 'CI Runner'),
  version: VERSION,
  description: L(
    "Your CI runners on the panel: whether the GitLab runner container is up and the jobs it runs, what its cache volumes cost on disk and how fast they grow, the free space left where Docker keeps them and when it runs out, and when the cleanup last ran; optionally runner status and waiting jobs from GitLab's API, GitHub Actions self-hosted runners and the runner's Prometheus metrics. Read-only: it never prunes or stops anything.",
    'Tus runners de CI en el panel: si el contenedor del runner de GitLab está en marcha y los trabajos que corre, lo que ocupan en disco sus volúmenes de caché y lo rápido que crecen, el espacio libre que queda donde Docker los guarda y cuándo se acaba, y cuándo corrió la limpieza; opcionalmente el estado de los runners y los trabajos en cola de la API de GitLab, los runners propios de GitHub Actions y las métricas Prometheus del runner. Solo lectura: nunca poda ni para nada.',
    'Deine CI-Runner auf dem Panel: ob der GitLab-Runner-Container läuft und welche Jobs er ausführt, was seine Cache-Volumes auf der Platte belegen und wie schnell sie wachsen, wie viel Platz dort, wo Docker sie ablegt, noch frei ist und wann er ausgeht, und wann die Bereinigung zuletzt lief; optional Runner-Status und wartende Jobs aus der GitLab-API, selbst gehostete GitHub-Actions-Runner und die Prometheus-Metriken des Runners. Nur lesend: Es räumt nie auf und stoppt nichts.',
    '在副屏上查看你的 CI Runner：GitLab Runner 容器是否在运行及其作业，缓存卷占用多少磁盘、增长多快，Docker 存放它们的磁盘还剩多少空间、何时占满，以及上次清理时间；还可选显示 GitLab API 中的 Runner 状态和排队作业、GitHub Actions 自托管 Runner 以及 Runner 的 Prometheus 指标。只读：从不清理或停止任何东西。',
    '在面板上查看你的 CI Runner：GitLab Runner 容器是否在執行及其作業，快取磁碟區占用多少磁碟、增長多快，Docker 存放它們的磁碟還剩多少空間、何時占滿，以及上次清理時間；還可選顯示 GitLab API 中的 Runner 狀態和排隊作業、GitHub Actions 自架 Runner 以及 Runner 的 Prometheus 指標。唯讀：從不清理或停止任何東西。',
  ),
  author: 'Loksly',
  license: 'MIT',
  homepage: 'https://github.com/kiosko-lcd/kiosko-plugin-runners#readme',
  repository: 'https://github.com/kiosko-lcd/kiosko-plugin-runners',
  icon: 'server',
  sdk: '^0.2.0',
  platforms: ['linux', 'darwin', 'win32'],
  languages: LANGUAGES,
  permissions: {
    // gitlab.com and api.github.com only with a token set; `user` for a self-managed GitLab, GitHub Enterprise or the metrics address; `lan` for the metrics on this machine.
    network: [...REMOTE_HOSTS, 'lan', 'user'],
    // Read-only subcommands only (src/run.ts): ps, volume ls, system df, info; systemctl show.
    exec: ['docker', 'podman', 'systemctl'],
    // statfs of Docker's data folder; config.toml only if you set its path.
    files: ['user'],
  },
  resources: { memoryMb: 15, cpu: 'low' },
  widgets: [now, cache, compact],
  sources: [runnersSource],
  templates: [
    {
      id: 'runners',
      name: L('CI runners', 'Runners de CI', 'CI-Runner', 'CI Runner', 'CI Runner'),
      icon: 'server',
      wide: [
        { x: 0, y: 0, w: 0.45, h: 1, widgets: ['now'] },
        { x: 0.45, y: 0, w: 0.55, h: 1, widgets: ['cache'] },
      ],
      tall: [
        { x: 0, y: 0, w: 1, h: 0.45, widgets: ['now'] },
        { x: 0, y: 0.45, w: 1, h: 0.55, widgets: ['cache'] },
      ],
    },
  ],
});
