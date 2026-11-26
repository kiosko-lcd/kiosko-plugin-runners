/** Numbers and sizes written the way the panel's language writes them, with Intl. */

const cache = new Map<string, Intl.NumberFormat>();

function nf(locale: string, o: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(o)}`;
  let f = cache.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat(locale, o);
    } catch {
      f = new Intl.NumberFormat('en', o);
    }
    cache.set(key, f);
  }
  return f;
}

/** Decimal units, as Docker writes them (`docker system df` says GB for 10⁹ bytes). */
const UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];

/** A size split in number and unit: `["28,9", "GB"]`; one decimal under 100, none from 100 on. */
export function bytesParts(locale: string, bytes: number): [string, string] {
  let v = Math.abs(bytes);
  let i = 0;
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1000;
    i++;
  }
  // 999.96 MB rounds to "1000": say 1 GB instead.
  if (v >= 99.95 && v < 100) v = 100;
  if (i > 0 && Math.round(v) >= 1000 && i < UNITS.length - 1) {
    v /= 1000;
    i++;
  }
  const digits = i === 0 || v >= 100 ? 0 : 1;
  return [`${bytes < 0 ? '−' : ''}${nf(locale, { maximumFractionDigits: digits, minimumFractionDigits: digits === 1 && v < 10 ? 1 : 0 }).format(v)}`, UNITS[i]!];
}

export const bytesText = (locale: string, bytes: number): string => bytesParts(locale, bytes).join(' ');

/** A share 0..1 as a percentage: "12 %", "3,4 %" (one decimal under 10 %). */
export function pctText(locale: string, v: number): string {
  const digits = v > 0 && v < 0.1 ? 1 : 0;
  return nf(locale, { style: 'percent', maximumFractionDigits: digits }).format(v);
}

export function intText(locale: string, n: number): string {
  return nf(locale, { maximumFractionDigits: 0 }).format(n);
}

/** Days with one decimal under 10 ("1,5"), whole above. */
export function daysNumber(locale: string, d: number): string {
  return nf(locale, { maximumFractionDigits: d < 10 ? 1 : 0 }).format(d);
}

const PER_DAY: Record<string, string> = { en: '/day', es: '/día', de: '/Tag', zh: '/天' };
export const perDayUnit = (locale: string): string => PER_DAY[locale.slice(0, 2)] ?? PER_DAY.en!;

/** "+38 GB/day", "+38 GB/día", "−2,1 GB/Tag". */
export function rateText(locale: string, perDay: number): string {
  const [n, u] = bytesParts(locale, perDay);
  return `${perDay > 0 ? '+' : ''}${n} ${u}${perDayUnit(locale)}`;
}
