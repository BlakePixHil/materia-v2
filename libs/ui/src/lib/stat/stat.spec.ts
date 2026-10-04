import { render, screen } from '@testing-library/angular';

import { MtDelta, MtSparkline, MtStat, sparklinePoints } from './stat';

describe('Stat, Sparkline and Delta', () => {
  it('scales points into the box', () => {
    expect(sparklinePoints([])).toEqual([]);
    expect(sparklinePoints([5])).toEqual([[0, 26]]);
    expect(sparklinePoints([0, 10])).toEqual([
      [0, 26],
      [100, 2],
    ]);
  });

  it('renders a stat with label, value and unit', async () => {
    const { container } = await render(MtStat, {
      inputs: { label: 'Billable this week', value: '18.4', unit: 'h', icon: 'clock' },
    });
    expect(container).toHaveTextContent('Billable this week');
    expect(container.querySelector('.v small')).toHaveTextContent('h');
  });

  it('renders a labelled sparkline, and nothing for an empty series', async () => {
    const { container, rerender } = await render(MtSparkline, {
      inputs: { values: [1, 3, 2], label: 'WIP, 12 weeks' },
    });
    expect(screen.getByRole('img', { name: 'WIP, 12 weeks' })).toBeInTheDocument();
    expect(container.querySelector('.line')?.getAttribute('d')).toBe('M0 26 L50 2 L100 14');
    expect(container.querySelector('.area')?.getAttribute('d')).toContain('L100 28 L0 28 Z');
    await rerender({ inputs: { values: [], label: 'Empty' } });
    expect(container.querySelector('.line')).toBeNull();
  });

  it('colours a delta by whether it is good news', async () => {
    const { container } = await render(
      `<mt-delta id="a" value="$2,140" direction="up" [good]="false" />
       <mt-delta id="b" value="3" direction="down" />
       <mt-delta id="c" value="3" direction="up" />`,
      { imports: [MtDelta] },
    );
    expect(container.querySelector('#a')).toHaveAttribute('data-dir', 'down');
    expect(container.querySelector('#a')).toHaveTextContent('Up $2,140');
    expect(container.querySelector('#b')).toHaveAttribute('data-dir', 'down');
    expect(container.querySelector('#c')).toHaveAttribute('data-dir', 'up');
  });
});
