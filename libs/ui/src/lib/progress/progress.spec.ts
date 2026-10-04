import { render, screen } from '@testing-library/angular';

import { MtMeter, MtProgress, percentOf } from './progress';

describe('Progress and Meter', () => {
  it('clamps percentages', () => {
    expect(percentOf(3, 9)).toBeCloseTo(33.33, 1);
    expect(percentOf(12, 10)).toBe(100);
    expect(percentOf(-1, 10)).toBe(0);
    expect(percentOf(1, 0)).toBe(0);
    expect(percentOf(Number.NaN, 10)).toBe(0);
  });

  it('renders an accessible progress bar', async () => {
    await render(MtProgress, {
      inputs: {
        value: 3,
        max: 9,
        label: 'Estate administration',
        valueLabel: '3 of 9 stages',
        tone: 'danger',
        size: 'md',
      },
    });
    const bar = screen.getByRole('progressbar', { name: 'Estate administration' });
    expect(bar).toHaveAttribute('aria-valuetext', '3 of 9 stages');
    expect(bar).toHaveAttribute('data-tone', 'danger');
    expect(bar).toHaveAttribute('data-size', 'md');
    expect((bar.firstElementChild as HTMLElement).style.width).toMatch(/^33\.3/);
  });

  it('renders a meter with a target', async () => {
    await render(MtMeter, { inputs: { value: 62, target: 75, label: 'Daniel Kim utilisation', tone: 'warning' } });
    const meter = screen.getByRole('meter', { name: 'Daniel Kim utilisation' });
    expect(meter).toHaveAttribute('aria-valuetext', '62%, target 75%');
    expect((meter.querySelector('b') as HTMLElement).style.left).toBe('75%');
  });

  it('renders a meter without a target', async () => {
    await render(MtMeter, { inputs: { value: 40, label: 'Usage' } });
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuetext', '40%');
    expect(screen.getByRole('meter').querySelector('b')).toBeNull();
  });
});
