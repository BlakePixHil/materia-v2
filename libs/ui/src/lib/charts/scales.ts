/**
 * Chart geometry, ported from `design/system/charts.py`: one linear scale per chart, nice ticks from
 * zero, bands for categories, and bars square at the baseline with a 4px rounded data end. Exported
 * for ScenarioBars (LIT-01) and anything else that draws a chart.
 */

/** A data point. `meta` is shown under the value in the tooltip and table ("Oct 2025"). */
export interface ChartDatum {
  label: string;
  value: number;
  meta?: string | undefined;
}

export type ChartFormat = (value: number) => string;

/** The design system's maximum bar thickness. */
export const MT_BAR_MAX = 24;
/** Radius of a bar's data end. */
export const MT_BAR_RADIUS = 4;
/** More bars than this switch a vertical chart to horizontal. */
export const MT_MAX_VERTICAL_BARS = 24;

/** A "nice" step (1, 2, 2.5 or 5 × 10^n) so that `span / step` is close to `count`. */
export function niceStep(span: number, count = 4): number {
  if (!Number.isFinite(span) || span <= 0) return 1;
  const raw = span / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const residual = raw / magnitude;
  const nice = residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 2.5 ? 2.5 : residual <= 5 ? 5 : 10;
  return nice * magnitude;
}

export interface NiceDomain {
  min: number;
  max: number;
  ticks: number[];
}

/**
 * A domain that always includes zero (bars start at the baseline), rounded out to nice ticks.
 * All zeros gives 0–1; negative values extend below zero.
 */
export function niceDomain(values: readonly number[], count = 4, extra: readonly number[] = []): NiceDomain {
  const all = [...values, ...extra].filter(Number.isFinite);
  let lo = Math.min(0, ...all);
  let hi = Math.max(0, ...all);
  // All zeros: just the baseline, no fractional ticks.
  if (lo === 0 && hi === 0) return { min: 0, max: 1, ticks: [0] };
  const step = niceStep(hi - lo, count);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return { min: lo, max: hi, ticks: ticks.map((t) => (Object.is(t, -0) ? 0 : t)) };
}

/** A domain fitted to the data (not forced to zero), for line charts. */
export function fittedDomain(values: readonly number[], count = 3, extra: readonly number[] = []): NiceDomain {
  const all = [...values, ...extra].filter(Number.isFinite);
  if (all.length === 0) return { min: 0, max: 1, ticks: [0, 1] };
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const step = niceStep(hi - lo, count);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return { min: lo, max: hi, ticks };
}

/** Maps a value in [d0, d1] to [r0, r1]. */
export function linearScale(d0: number, d1: number, r0: number, r1: number): (value: number) => number {
  const span = d1 - d0 || 1;
  return (value) => r0 + ((value - d0) / span) * (r1 - r0);
}

/** Bands for `count` categories across [r0, r1]: start, width and centre of each. */
export function bandScale(
  count: number,
  r0: number,
  r1: number,
): { band: number; start: (i: number) => number; centre: (i: number) => number } {
  const band = count > 0 ? (r1 - r0) / count : 0;
  return { band, start: (i) => r0 + band * i, centre: (i) => r0 + band * i + band / 2 };
}

/** Bar thickness for a band: half the band, at most 24px. */
export function barThickness(band: number): number {
  return Math.max(1, Math.min(MT_BAR_MAX, band * 0.5));
}

const f = (n: number) => (Math.round(n * 10) / 10).toString();

/**
 * A vertical bar from `base` to `y` with the data end rounded (top for positive values, bottom for
 * negative ones) and the baseline end square.
 */
export function verticalBarPath(x: number, width: number, y: number, base: number, radius = MT_BAR_RADIUS): string {
  const height = Math.abs(base - y);
  if (height === 0) return '';
  const r = Math.min(radius, height, width / 2);
  if (y <= base) {
    return `M${f(x)},${f(base)}V${f(y + r)}Q${f(x)},${f(y)} ${f(x + r)},${f(y)}H${f(x + width - r)}Q${f(x + width)},${f(y)} ${f(x + width)},${f(y + r)}V${f(base)}Z`;
  }
  return `M${f(x)},${f(base)}V${f(y - r)}Q${f(x)},${f(y)} ${f(x + r)},${f(y)}H${f(x + width - r)}Q${f(x + width)},${f(y)} ${f(x + width)},${f(y - r)}V${f(base)}Z`;
}

/** A horizontal bar from `base` to `x`, rounded at the data end. */
export function horizontalBarPath(y: number, height: number, x: number, base: number, radius = MT_BAR_RADIUS): string {
  const width = Math.abs(x - base);
  if (width === 0) return '';
  const r = Math.min(radius, width, height / 2);
  if (x >= base) {
    return `M${f(base)},${f(y)}H${f(x - r)}Q${f(x)},${f(y)} ${f(x)},${f(y + r)}V${f(y + height - r)}Q${f(x)},${f(y + height)} ${f(x - r)},${f(y + height)}H${f(base)}Z`;
  }
  return `M${f(base)},${f(y)}H${f(x + r)}Q${f(x)},${f(y)} ${f(x)},${f(y + r)}V${f(y + height - r)}Q${f(x)},${f(y + height)} ${f(x + r)},${f(y + height)}H${f(base)}Z`;
}

/** Compact tick labels: `$41.2k`, `1.5m`, or the plain number. */
export function compactNumber(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}${trim(abs / 1_000_000)}m`;
  if (abs >= 1_000) return `${sign}${trim(abs / 1_000)}k`;
  return `${sign}${trim(abs)}`;
}

function trim(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

/**
 * The generated accessible summary: what it shows, the range and the highest and lowest points.
 * `"Billed by month, 12 points. Highest Jun: $63,400. Lowest Jan: $28,100. Latest Sep: $46,000."`
 */
export function chartSummary(title: string, data: readonly ChartDatum[], format: ChartFormat): string {
  if (data.length === 0) return `${title}: no data.`;
  const first = data[0] as ChartDatum;
  let hi = first;
  let lo = first;
  for (const d of data) {
    if (d.value > hi.value) hi = d;
    if (d.value < lo.value) lo = d;
  }
  const last = data[data.length - 1] as ChartDatum;
  if (data.length === 1) return `${title}, 1 point. ${first.label}: ${format(first.value)}.`;
  return `${title}, ${data.length} points. Highest ${hi.label}: ${format(hi.value)}. Lowest ${lo.label}: ${format(lo.value)}. Latest ${last.label}: ${format(last.value)}.`;
}
