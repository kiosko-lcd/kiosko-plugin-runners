/** Every word the widgets paint, in the plugin's five languages. */
import type { Localized } from '@kiosko/sdk';
import { L } from './i18n.ts';

export const WAITING = L('Reading the runners…', 'Leyendo los runners…', 'Runner werden gelesen…', '正在读取 Runner…', '正在讀取 Runner…');
export const NOTHING = L('No runner set up', 'Ningún runner configurado', 'Kein Runner eingerichtet', '未设置 Runner', '未設定 Runner');
export const NOTHING_HOW = L('Docker, a token or metrics: Settings → Data sources', 'Docker, un token o métricas: Ajustes → Fuentes de datos', 'Docker, ein Token oder Metriken: Einstellungen → Datenquellen', 'Docker、令牌或指标：设置 → 数据源', 'Docker、權杖或指標：設定 → 資料來源');

export const RUNNER = L('Runner', 'Runner', 'Runner', 'Runner', 'Runner');
export const STATE: Record<string, Localized> = {
  running: L('Up', 'En marcha', 'Läuft', '运行中', '執行中'),
  restarting: L('Restarting', 'Reiniciando', 'Startet neu', '正在重启', '正在重新啟動'),
  paused: L('Paused', 'En pausa', 'Pausiert', '已暂停', '已暫停'),
  exited: L('Down', 'Parado', 'Gestoppt', '已停止', '已停止'),
  created: L('Not started', 'Sin arrancar', 'Nicht gestartet', '未启动', '未啟動'),
  dead: L('Down', 'Parado', 'Gestoppt', '已停止', '已停止'),
};
export const NO_RUNNER = L('No runner container', 'Sin contenedor del runner', 'Kein Runner-Container', '没有 Runner 容器', '沒有 Runner 容器');
/** `{d}`: "10 d". */
export const UP_FOR = L('up {d}', 'activo {d}', 'seit {d}', '已运行 {d}', '已執行 {d}');

/** `{n}`: a number; the noun follows it. */
export const JOBS = L('jobs', 'trabajos', 'Jobs', '个作业', '個作業');
export const JOB = L('job', 'trabajo', 'Job', '个作业', '個作業');
export const RUNNING = L('running', 'en marcha', 'laufen', '运行中', '執行中');
export const IDLE = L('No jobs running', 'Ningún trabajo en marcha', 'Keine Jobs laufen', '没有运行中的作业', '沒有執行中的作業');
export const PENDING = L('pending', 'en cola', 'wartend', '排队中', '排隊中');
/** `{d}`: "12 min". */
export const OLDEST = L('oldest {d}', 'la más antigua {d}', 'ältester {d}', '最久 {d}', '最久 {d}');

export const ONLINE = L('online', 'en línea', 'online', '在线', '線上');
export const OFFLINE = L('offline', 'desconectado', 'offline', '离线', '離線');
export const PAUSED = L('paused', 'en pausa', 'pausiert', '已暂停', '已暫停');
export const STALE = L('stale', 'inactivo', 'veraltet', '已失效', '已失效');
export const NEVER = L('never seen', 'nunca visto', 'nie gesehen', '从未连接', '從未連線');
export const BUSY = L('busy', 'ocupado', 'beschäftigt', '忙碌', '忙碌');

export const CACHE = L('cache', 'caché', 'Cache', '缓存', '快取');
export const BUILDS = L('builds', 'builds', 'Builds', '构建目录', '建置目錄');
export const PROTECTED = L('protected', 'protegidas', 'geschützt', '受保护', '受保護');
export const ON_DISK = L('Caches on disk', 'Cachés en disco', 'Caches auf der Platte', '磁盘上的缓存', '磁碟上的快取');
/** `{n}`: "62". */
export const VOLUMES = L('{n} volumes', '{n} volúmenes', '{n} Volumes', '{n} 个卷', '{n} 個磁碟區');
/** `{v}`: "48 GB". */
export const FREE = L('{v} free', '{v} libres', '{v} frei', '可用 {v}', '可用 {v}');
/** `{d}`: "3 d". */
export const FULL_IN = L('full in {d}', 'lleno en {d}', 'voll in {d}', '{d}后占满', '{d}後占滿');
export const FULL_NOW = L('disk full', 'disco lleno', 'Platte voll', '磁盘已满', '磁碟已滿');
export const NOT_GROWING = L('not growing', 'no crece', 'wächst nicht', '未增长', '未增長');
export const GROWTH_SOON = L('growth: measuring', 'crecimiento: midiendo', 'Wachstum: wird gemessen', '增长：测量中', '增長：測量中');
/** `{d}`: "2 h" of history so far. */
export const GROWTH_DATA = L('measuring growth ({d} of data)', 'midiendo crecimiento ({d} de datos)', 'Wachstum wird gemessen ({d} Daten)', '正在测量增长（已有 {d} 数据）', '正在測量增長（已有 {d} 資料）');
/** `{v}`: "+2.5 GB", `{d}`: "2 h". */
export const ADDED_IN = L('{v} in {d}', '{v} en {d}', '{v} in {d}', '{d}内 {v}', '{d}內 {v}');
export const MEASURING = L('Measuring the volumes…', 'Midiendo los volúmenes…', 'Volumes werden gemessen…', '正在测量卷…', '正在測量磁碟區…');
/** `{d}`: "1 min". */
export const FIRST_IN = L('First measurement in {d}', 'Primera medida en {d}', 'Erste Messung in {d}', '{d}后首次测量', '{d}後首次測量');
export const MEASURED = L('measured {ago}', 'medido {ago}', 'gemessen {ago}', '{ago}测量', '{ago}測量');
export const LAST_DAY = L('last 24 h', 'últimas 24 h', 'letzte 24 h', '最近 24 小时', '最近 24 小時');

/** `{ago}`: "14 h ago". */
export const CLEANED = L('cleaned {ago}', 'limpieza {ago}', 'bereinigt {ago}', '{ago}已清理', '{ago}已清理');
export const CLEAN_NEVER = L('cleanup never ran', 'la limpieza no ha corrido', 'Bereinigung lief nie', '清理从未运行', '清理從未執行');
export const CLEAN_MISSING = L('cleanup timer not found', 'no existe el temporizador de limpieza', 'Bereinigungs-Timer fehlt', '找不到清理定时器', '找不到清理計時器');
export const CLEAN_FAILED = L('cleanup failed', 'la limpieza falló', 'Bereinigung fehlgeschlagen', '清理失败', '清理失敗');

export const ENGINE_ERROR: Record<string, Localized> = {
  missing: L('{engine} not installed', '{engine} no está instalado', '{engine} nicht installiert', '未安装 {engine}', '未安裝 {engine}'),
  'not-running': L('{engine} is not answering', '{engine} no responde', '{engine} antwortet nicht', '{engine} 无响应', '{engine} 沒有回應'),
  permission: L('No permission to use {engine}', 'Sin permiso para usar {engine}', 'Keine Berechtigung für {engine}', '无权使用 {engine}', '無權使用 {engine}'),
  other: L("Can't read {engine}", 'No se puede leer {engine}', '{engine} nicht lesbar', '无法读取 {engine}', '無法讀取 {engine}'),
};
export const REMOTE_DISK = L('disk not visible from here', 'disco no visible desde aquí', 'Platte von hier nicht sichtbar', '无法从本机查看磁盘', '無法從本機查看磁碟');
/** `{name}`: "GitLab". `{why}`: "unauthorized". */
export const API_ERROR = L('{name}: {why}', '{name}: {why}', '{name}: {why}', '{name}：{why}', '{name}：{why}');

export const fill = (text: string, values: Record<string, string>): string => text.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);
export const DISK_FREE = L('Free disk', 'Disco libre', 'Freier Platz', '可用磁盘', '可用磁碟');
export const JOBS_RUNNING = L('Jobs running', 'Trabajos en marcha', 'Laufende Jobs', '运行中的作业', '執行中的作業');
