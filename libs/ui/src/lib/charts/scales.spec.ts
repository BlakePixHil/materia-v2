import { truncateLabel } from './chart-base';
import {
  bandScale,
  barThickness,
  chartSummary,
  compactNumber,
  fittedDomain,
  horizontalBarPath,
  linearScale,
  MT_BAR_MAX,
  niceDomain,
  niceStep,
  verticalBarPath,
} from './scales';

describe('chart scales', () => {
  it('picks nice steps', () => {
    expect(niceStep(63_400, 4)).toBe(20_000);
    expect(niceStep(10, 4)).toBe(2.5);
    expect(niceStep(7, 4)).toBe(2);
    expect(niceStep(4, 4)).toBe(1);
    expect(niceStep(30, 4)).toBe(10);
    expect(niceStep(0)).toBe(1);
    expect(niceStep(Number.NaN)).toBe(1);
  });

  it('builds a zero-based domain with nice ticks', () => {
    expect(niceDomain([41_200, 63_400, 28_100])).toEqual({
      min: 0,
      max: 80_000,
      ticks: [0, 20_000, 40_000, 60_000, 80_000],
    });
    expect(niceDomain([0, 0, 0])).toEqual({ min: 0, max: 1, ticks: [0] });
    expect(niceDomain([5])).toEqual({ min: 0, max: 6, ticks: [0, 2, 4, 6] });
    const negative = niceDomain([-1200, 3400]);
    expect(negative.min).toBeLessThan(0);
    expect(negative.ticks).toContain(0);
    expect(niceDomain([10], 4, [52])).toMatchObject({ max: 60 });
  });

  it('fits a domain to the data for lines', () => {
    expect(fittedDomain([52, 41, 58])).toEqual({ min: 40, max: 60, ticks: [40, 50, 60] });
    expect(fittedDomain([], 3)).toEqual({ min: 0, max: 1, ticks: [0, 1] });
    expect(fittedDomain([5, 5])).toMatchObject({ min: 4, max: 6 });
    expect(fittedDomain([40], 3, [30]).min).toBeLessThanOrEqual(30);
  });

  it('maps values and bands', () => {
    const y = linearScale(0, 100, 200, 0);
    expect(y(0)).toBe(200);
    expect(y(50)).toBe(100);
    expect(linearScale(5, 5, 0, 10)(5)).toBe(0);
    const bands = bandScale(4, 0, 400);
    expect(bands.band).toBe(100);
    expect(bands.start(1)).toBe(100);
    expect(bands.centre(1)).toBe(150);
    expect(bandScale(0, 0, 100).band).toBe(0);
    expect(barThickness(100)).toBe(MT_BAR_MAX);
    expect(barThickness(20)).toBe(10);
    expect(barThickness(0)).toBe(1);
  });

  it('draws bars square at the baseline and rounded at the data end', () => {
    expect(verticalBarPath(10, 20, 50, 200)).toBe('M10,200V54Q10,50 14,50H26Q30,50 30,54V200Z');
    expect(verticalBarPath(10, 20, 250, 200)).toBe('M10,200V246Q10,250 14,250H26Q30,250 30,246V200Z');
    expect(verticalBarPath(10, 20, 200, 200)).toBe('');
    // A short bar's radius never exceeds its height.
    expect(verticalBarPath(0, 20, 198, 200)).toContain('V200');
    expect(horizontalBarPath(10, 14, 100, 0)).toBe('M0,10H96Q100,10 100,14V20Q100,24 96,24H0Z');
    expect(horizontalBarPath(10, 14, -50, 0)).toBe('M0,10H-46Q-50,10 -50,14V20Q-50,24 -46,24H0Z');
    expect(horizontalBarPath(10, 14, 0, 0)).toBe('');
  });

  it('formats compact ticks and truncates labels', () => {
    expect(compactNumber(41_200)).toBe('41.2k');
    expect(compactNumber(1_500_000)).toBe('1.5m');
    expect(compactNumber(-2_000)).toBe('-2k');
    expect(compactNumber(12)).toBe('12');
    expect(truncateLabel('Estate of Desmond Featherstonehaugh', 12)).toBe('Estate of D…');
    expect(truncateLabel('Oct')).toBe('Oct');
  });

  it('summarises the data for screen readers', () => {
    const fmt = (v: number) => `$${v}`;
    expect(chartSummary('Billed', [], fmt)).toBe('Billed: no data.');
    expect(chartSummary('Billed', [{ label: 'Oct', value: 3 }], fmt)).toBe('Billed, 1 point. Oct: $3.');
    expect(
      chartSummary(
        'Billed',
        [
          { label: 'Oct', value: 3 },
          { label: 'Nov', value: 9 },
          { label: 'Dec', value: 1 },
          { label: 'Jan', value: 4 },
        ],
        fmt,
      ),
    ).toBe('Billed, 4 points. Highest Nov: $9. Lowest Dec: $1. Latest Jan: $4.');
  });
});
