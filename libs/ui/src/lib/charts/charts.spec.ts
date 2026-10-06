import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';

import { MtBarChart } from './bar-chart';
import { MtLineChart } from './line-chart';
import type { ChartDatum } from './scales';

const MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];
const BILLED: ChartDatum[] = [41_200, 47_800, 39_500, 28_100, 44_600, 55_300].map((value, i) => ({
  label: MONTHS[i] ?? '',
  value,
  meta: `${MONTHS[i]} 2025`,
}));
const money = (v: number) => `$${v.toLocaleString('en-AU')}`;

const points = (container: Element) => [...container.querySelectorAll<SVGElement>('[data-point]')];

describe('MtBarChart', () => {
  it('renders an img with a generated summary, one bar per datum, a target and a table view', async () => {
    const { container } = await render(MtBarChart, {
      inputs: {
        data: BILLED,
        label: 'Billed by month',
        format: money,
        target: { value: 52_000, label: 'Target $52k' },
        highlight: 5,
        categoryLabel: 'Month',
        valueLabel: 'Billed',
      },
    });
    const img = container.querySelector('svg.mt-chart');
    expect(img).toHaveAttribute('role', 'img');
    expect(img).toHaveAccessibleName(
      'Billed by month, 6 points. Highest Mar: $55,300. Lowest Jan: $28,100. Latest Mar: $55,300.',
    );
    expect(container.querySelectorAll('path.bar')).toHaveLength(6);
    expect(container.querySelectorAll('path.bar.muted')).toHaveLength(5);
    expect(container.querySelector('line.ref')).not.toBeNull();
    expect(screen.getByText('Target $52k', { selector: 'text' })).toBeInTheDocument();
    expect(container.querySelector('line.base')).not.toBeNull();
    // Table view
    const table = screen.getByRole('table', { hidden: true });
    expect(within(table).getAllByRole('row', { hidden: true })).toHaveLength(7);
    expect(within(table).getByText('Jan 2025')).toBeInTheDocument();
    expect(within(table).getAllByText('$52,000')).toHaveLength(6);
  });

  it('moves between bars with the keyboard and shows a tooltip on focus and hover', async () => {
    const { container } = await render(MtBarChart, { inputs: { data: BILLED, label: 'Billed', format: money } });
    const bars = points(container);
    expect(bars.map((b) => b.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1', '-1', '-1']);
    expect(bars[0]).toHaveAttribute('aria-label', 'Oct 2025: $41,200');
    await userEvent.tab();
    expect(bars[0]).toHaveFocus();
    expect(screen.getByRole('tooltip')).toHaveTextContent('$41,200');
    await userEvent.keyboard('{ArrowRight}');
    expect(points(container)[1]).toHaveFocus();
    expect(screen.getByRole('tooltip')).toHaveTextContent('Nov 2025');
    await userEvent.keyboard('{End}');
    expect(points(container)[5]).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(points(container)[5]).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(points(container)[0]).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(points(container)[0]).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
    await userEvent.keyboard('a');
    await userEvent.hover(points(container)[3] as Element);
    expect(screen.getByRole('tooltip')).toHaveTextContent('$28,100');
    await userEvent.unhover(container.querySelector('svg') as Element);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('opens a bar on click, Enter or Space when its points drill down, and not otherwise', async () => {
    const opened: ChartDatum[] = [];
    const { container, rerender } = await render(MtBarChart, {
      inputs: { data: BILLED, label: 'Billed', format: money, drill: true },
      on: { pointSelect: (datum: ChartDatum) => opened.push(datum) },
    });
    expect(points(container).every((bar) => bar.getAttribute('role') === 'button')).toBe(true);
    await userEvent.click(points(container)[2] as Element);
    expect(opened.map((d) => d.meta)).toEqual(['Dec 2025']);
    (points(container)[0] as SVGElement).focus();
    await userEvent.keyboard('{ArrowRight}{Enter}');
    await userEvent.keyboard(' ');
    expect(opened.map((d) => d.meta)).toEqual(['Dec 2025', 'Nov 2025', 'Nov 2025']);

    await rerender({ inputs: { data: BILLED, label: 'Billed', format: money, drill: false } });
    expect(points(container)[0]).toHaveAttribute('role', 'img');
    await userEvent.click(points(container)[4] as Element);
    expect(opened).toHaveLength(3);
  });

  it('switches to horizontal bars past 24, with values at the tips and truncated labels', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ label: `Matter with a very long name ${i}`, value: i - 5 }));
    const { container } = await render(MtBarChart, {
      inputs: { data: many, label: 'WIP by matter', target: { value: 10, label: 'Cap' } },
    });
    expect(container.querySelectorAll('path.bar')).toHaveLength(29); // the zero bar draws nothing
    expect(screen.getAllByText('Matter with a ver…')).toHaveLength(30);
    expect(container.querySelectorAll('text.val')).toHaveLength(30);
    expect(container.querySelector('line.ref')).not.toBeNull();
  });

  it('labels chosen vertical bars, including negative ones', async () => {
    const data = [
      { label: 'Write-offs', value: -1200 },
      { label: 'Billed', value: 3400 },
    ];
    const { container } = await render(MtBarChart, {
      inputs: { data, label: 'Net', labelPoints: [0, 1], orientation: 'vertical' },
    });
    expect([...container.querySelectorAll('text.val')].map((t) => t.textContent?.trim())).toEqual(['-1,200', '3,400']);
  });

  it('shows an empty state', async () => {
    await render(MtBarChart, { inputs: { data: [], label: 'Billed' } });
    expect(screen.getByText('No data for this period')).toBeInTheDocument();
  });

  it('shows a busy loading state', async () => {
    const { fixture } = await render(MtBarChart, { inputs: { data: BILLED, label: 'Billed', loading: true } });
    expect(screen.getByText('Loading Billed')).toBeInTheDocument();
    expect(fixture.nativeElement).toHaveAttribute('aria-busy', 'true');
  });

  it('renders all zeros and a single point', async () => {
    const { container } = await render(MtBarChart, { inputs: { data: [{ label: 'Oct', value: 0 }], label: 'Billed' } });
    expect(container.querySelector('svg.mt-chart')).toHaveAccessibleName('Billed, 1 point. Oct: 0.');
    expect(container.querySelectorAll('line.base')).toHaveLength(1);
    expect(container.querySelectorAll('[data-point]')).toHaveLength(1);
  });
});

describe('MtLineChart', () => {
  const DAYS: ChartDatum[] = [52, 49, 55, 58, 47, 41].map((value, i) => ({ label: MONTHS[i] ?? '', value }));
  const LAST_YEAR: ChartDatum[] = [60, 58, 61, 63, 55, 50].map((value, i) => ({ label: MONTHS[i] ?? '', value }));
  const days = (v: number) => `${v} days`;

  it('draws the line, area, end label, reference and a neutral comparison', async () => {
    const { container } = await render(MtLineChart, {
      inputs: {
        data: DAYS,
        comparison: LAST_YEAR,
        comparisonLabel: 'Last year',
        reference: { value: 38, label: 'NSW median 38' },
        label: 'Days to grant',
        format: days,
      },
    });
    expect(container.querySelector('polyline.line:not(.cmp)')?.getAttribute('points')?.split(' ')).toHaveLength(6);
    expect(container.querySelector('polyline.line.cmp')).not.toBeNull();
    expect(container.querySelector('path.area')?.getAttribute('d')).toMatch(/^M/);
    expect(screen.getByText('41 days', { selector: 'text' })).toBeInTheDocument();
    expect(screen.getByText('NSW median 38', { selector: 'text' })).toBeInTheDocument();
    expect(points(container)[0]).toHaveAttribute('aria-label', 'Oct: 52 days; Last year: 60 days');
    const table = screen.getByRole('table', { hidden: true });
    expect(within(table).getByText('Last year')).toBeInTheDocument();
  });

  it('focuses points with arrows and shows the comparison in the tooltip', async () => {
    const { container } = await render(MtLineChart, {
      inputs: {
        data: DAYS,
        comparison: LAST_YEAR.slice(0, 3),
        comparisonLabel: 'Last year',
        label: 'Days',
        format: days,
      },
    });
    await userEvent.tab();
    await userEvent.keyboard('{ArrowRight}');
    expect(points(container)[1]).toHaveFocus();
    expect(screen.getByRole('tooltip')).toHaveTextContent('49 days');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Last year: 58 days');
    expect(container.querySelectorAll('circle.dot')).toHaveLength(2); // focused point + end dot
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('tooltip')).not.toHaveTextContent('Last year');
    const table = screen.getByRole('table', { hidden: true });
    expect(within(table).getAllByText('—')).toHaveLength(3);
  });

  it('handles one point, empty and loading', async () => {
    const { container, rerender } = await render(MtLineChart, {
      inputs: { data: [{ label: 'Oct', value: 41 }], label: 'Days' },
    });
    expect(points(container)).toHaveLength(1);
    await rerender({ inputs: { data: [], label: 'Days' } });
    expect(screen.getByText('No data for this period')).toBeInTheDocument();
    await rerender({ inputs: { data: DAYS, label: 'Days', loading: true } });
    expect(screen.getByText('Loading Days')).toBeInTheDocument();
  });
});
