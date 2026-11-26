/**
 * Full-screen alerts, from the source's data (on by default, the switch in
 * the source's options):
 *
 * - The runner container is down (critical) or restarting (warning); and
 *   Docker itself not answering (critical).
 * - The disk holding Docker's data under `diskFreeMinPct` free (15 % by
 *   default): critical, with how long it lasts at the current growth.
 * - The caches growing faster than `growthMaxGb` a day (20 GB): warning.
 * - A job waiting for a runner longer than `pendingMaxMs` (15 min), from
 *   GitLab's or GitHub's API: warning.
 * - The cleanup timer not run for `timerMaxMs` (26 h), or its last run
 *   failed: warning.
 * - A runner GitLab or GitHub sees offline: warning.
 *
 * Each alert's id names its episode (the container, the day, the oldest
 * job), so Kiosko shows it once, not every read. Alerts get no formatters:
 * numbers are written here in every language.
 */
import type { Alert, Localized } from '@kiosko/sdk';
import { bytesText, daysNumber, intText, pctText, rateText } from './format.ts';
import { L } from './i18n.ts';
import type { RunnersData } from './types.ts';

const LANGS = ['en', 'es', 'de', 'zh-Hans', 'zh-Hant'] as const;
type Lang = (typeof LANGS)[number];
const each = (fn: (l: Lang) => string): Localized => L(fn('en'), fn('es'), fn('de'), fn('zh-Hans'), fn('zh-Hant'));
const w = (l: Lang, words: Record<Lang, string>) => words[l];

function daysText(l: Lang, d: number): string {
  if (d < 1) {
    const h = Math.max(1, Math.round(d * 24));
    return `${intText(l, h)} ${w(l, { en: 'h', es: 'h', de: 'Std.', 'zh-Hans': '小时', 'zh-Hant': '小時' })}`;
  }
  return `${daysNumber(l, d)} ${w(l, { en: d === 1 ? 'day' : 'days', es: d === 1 ? 'día' : 'días', de: d === 1 ? 'Tag' : 'Tage', 'zh-Hans': '天', 'zh-Hant': '天' })}`;
}

function minutesText(l: Lang, ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m >= 120) return `${intText(l, Math.round(m / 60))} ${w(l, { en: 'h', es: 'h', de: 'Std.', 'zh-Hans': '小时', 'zh-Hant': '小時' })}`;
  return `${intText(l, m)} ${w(l, { en: 'min', es: 'min', de: 'Min.', 'zh-Hans': '分钟', 'zh-Hant': '分鐘' })}`;
}

const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

export function runnerAlerts(data: RunnersData | undefined, now: number): Alert[] {
  if (!data?.alerts.enabled) return [];
  const out: Alert[] = [];
  const local = data.local;
  const t = data.thresholds;

  if (local?.error === 'not-running' || local?.error === 'permission') {
    const engine = local.engine === 'podman' ? 'Podman' : 'Docker';
    out.push({
      id: `engine-${local.error}`,
      level: 'critical',
      icon: 'circle-x',
      title: each((l) => w(l, { en: `${engine} is not answering`, es: `${engine} no responde`, de: `${engine} antwortet nicht`, 'zh-Hans': `${engine} 无响应`, 'zh-Hant': `${engine} 沒有回應` })),
      text: local.error === 'permission' ? L('No permission to use its socket', 'Sin permiso para usar su socket', 'Keine Berechtigung für seinen Socket', '无权使用其套接字', '無權使用其通訊端') : L('The runner cannot start jobs', 'El runner no puede arrancar trabajos', 'Der Runner kann keine Jobs starten', 'Runner 无法启动作业', 'Runner 無法啟動作業'),
    });
  }

  for (const r of local?.runners ?? []) {
    if (r.state === 'running' && r.health !== 'unhealthy') continue;
    const restarting = r.state === 'restarting';
    out.push({
      id: `runner-${r.state}-${r.name}-${r.createdAt ?? ''}`,
      level: restarting || r.state === 'paused' ? 'warn' : 'critical',
      icon: restarting ? 'triangle-alert' : 'circle-x',
      title: restarting
        ? L('The runner keeps restarting', 'El runner se reinicia una y otra vez', 'Der Runner startet ständig neu', 'Runner 不断重启', 'Runner 不斷重新啟動')
        : r.state === 'running'
          ? L('The runner is unhealthy', 'El runner no está sano', 'Der Runner ist nicht gesund', 'Runner 状态异常', 'Runner 狀態異常')
          : L('The runner is down', 'El runner está parado', 'Der Runner ist gestoppt', 'Runner 已停止', 'Runner 已停止'),
      text: each(() => `${r.name} · ${r.status}`.slice(0, 120)),
    });
  }

  const disk = local?.disk;
  if (disk && disk.freeShare < t.diskFreeMin) {
    const full = local?.fullInDays;
    out.push({
      id: `disk-${disk.path}-${dayOf(now)}`,
      level: 'critical',
      icon: 'octagon-alert',
      title: L('The disk with the runner caches is almost full', 'El disco de las cachés del runner está casi lleno', 'Die Platte mit den Runner-Caches ist fast voll', 'Runner 缓存所在磁盘快满了', 'Runner 快取所在磁碟快滿了'),
      text: each((l) => {
        const free = `${bytesText(l, disk.freeBytes)} (${pctText(l, disk.freeShare)})`;
        const left = full !== null && full !== undefined ? ` · ${w(l, { en: 'full in', es: 'lleno en', de: 'voll in', 'zh-Hans': '将在', 'zh-Hant': '將在' })} ${daysText(l, full)}${l.startsWith('zh') ? '后占满' : ''}` : '';
        return `${w(l, { en: 'Free:', es: 'Libre:', de: 'Frei:', 'zh-Hans': '可用：', 'zh-Hant': '可用：' })} ${free}${left}`;
      }),
    });
  }

  const g = local?.growth.perDay;
  if (g != null && g > t.growthMax) {
    out.push({
      id: `growth-${dayOf(now)}`,
      level: 'warn',
      icon: 'activity',
      title: L('The runner caches grow fast', 'Las cachés del runner crecen rápido', 'Die Runner-Caches wachsen schnell', 'Runner 缓存增长很快', 'Runner 快取增長很快'),
      text: each((l) => `${rateText(l, g)} · ${w(l, { en: 'limit', es: 'límite', de: 'Grenze', 'zh-Hans': '上限', 'zh-Hant': '上限' })} ${rateText(l, t.growthMax)}`),
    });
  }

  for (const [name, api] of [['GitLab', data.gitlab], ['GitHub', data.github]] as const) {
    if (!api) continue;
    if (api.oldestPendingAt !== null && now - api.oldestPendingAt > t.pendingMaxMs) {
      out.push({
        id: `pending-${name}-${api.oldestPendingAt}`,
        level: 'warn',
        icon: 'bell',
        title: L('A job is waiting for a runner', 'Un trabajo espera a un runner', 'Ein Job wartet auf einen Runner', '有作业在等待 Runner', '有作業在等待 Runner'),
        text: each((l) => `${name} · ${intText(l, api.pending)} ${w(l, { en: 'waiting', es: 'en cola', de: 'wartend', 'zh-Hans': '个排队', 'zh-Hant': '個排隊' })} · ${w(l, { en: 'the oldest for', es: 'la más antigua desde hace', de: 'der älteste seit', 'zh-Hans': '最久已等', 'zh-Hant': '最久已等' })} ${minutesText(l, now - api.oldestPendingAt!)}`),
      });
    }
    for (const r of api.runners) {
      if (r.status !== 'offline' && r.status !== 'stale') continue;
      out.push({
        id: `offline-${name}-${r.id}-${r.contactedAt ?? ''}`,
        level: 'warn',
        icon: 'triangle-alert',
        title: each((l) => w(l, { en: `${name} sees a runner offline`, es: `${name} ve un runner desconectado`, de: `${name} sieht einen Runner offline`, 'zh-Hans': `${name} 显示 Runner 离线`, 'zh-Hant': `${name} 顯示 Runner 離線` })),
        text: each(() => r.name),
      });
    }
  }

  const timer = local?.timer;
  if (timer) {
    const late = timer.found && (timer.lastAt === null || now - timer.lastAt > t.timerMaxMs);
    const failed = timer.found && timer.result !== null && timer.result !== 'success';
    if (!timer.found || late || failed) {
      out.push({
        id: `timer-${timer.unit}-${!timer.found ? 'missing' : failed ? `failed-${timer.lastAt}` : `late-${timer.lastAt}`}`,
        level: 'warn',
        icon: 'triangle-alert',
        title: !timer.found
          ? L('The cache cleanup timer is missing', 'Falta el temporizador de limpieza de cachés', 'Der Timer für die Cache-Bereinigung fehlt', '缓存清理定时器不存在', '快取清理計時器不存在')
          : failed
            ? L('The cache cleanup failed', 'La limpieza de cachés falló', 'Die Cache-Bereinigung ist fehlgeschlagen', '缓存清理失败', '快取清理失敗')
            : L('The cache cleanup has not run', 'La limpieza de cachés no ha corrido', 'Die Cache-Bereinigung ist nicht gelaufen', '缓存清理没有运行', '快取清理沒有執行'),
        text: each((l) =>
          timer.lastAt === null
            ? timer.unit
            : `${timer.unit} · ${w(l, { en: 'last run', es: 'última vez hace', de: 'zuletzt vor', 'zh-Hans': '上次运行于', 'zh-Hant': '上次執行於' })} ${minutesText(l, now - timer.lastAt)}${l.startsWith('zh') ? '前' : l === 'en' ? ' ago' : ''}`,
        ),
      });
    }
  }
  return out;
}
