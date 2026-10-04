import { render, screen } from '@testing-library/angular';

import { dateOnly } from '@materia/domain';

import { MtDeadlineChip } from './deadline-chip';
import { MT_TODAY } from '../pipes/format';

const providers = [{ provide: MT_TODAY, useValue: () => dateOnly('2026-10-03') }];

describe('MtDeadlineChip', () => {
  it.each([
    ['2026-10-01', false, 'overdue', 'Overdue 2d'],
    ['2026-10-03', false, 'today', 'Today'],
    ['2026-10-05', false, 'soon', 'In 2 days'],
    ['2026-10-28', false, 'upcoming', '28 Oct'],
    ['2026-09-01', true, 'done', 'Done'],
  ])('%s (completed %s) is %s and reads %s', async (due, completed, tone, label) => {
    const { container } = await render(MtDeadlineChip, { inputs: { due, completed }, providers });
    const chip = container as HTMLElement;
    expect(chip).toHaveAttribute('data-urgency', tone);
    expect(chip).toHaveTextContent(label);
  });

  it('marks critical deadlines, takes a label override, and becomes focusable with a trace', async () => {
    const { container } = await render(MtDeadlineChip, {
      inputs: { due: '2026-10-16', critical: true, label: 'Filed 1 Oct', trace: 'UCPR r 78.3' },
      providers,
    });
    expect(container).toHaveAttribute('data-critical');
    expect(container).toHaveAttribute('tabindex', '0');
    expect(screen.getByText(', critical')).toHaveClass('mt-sr');
    expect(container).toHaveTextContent('Filed 1 Oct');
  });

  it('shows an em dash for a missing date', async () => {
    const { container } = await render(MtDeadlineChip, { inputs: { due: null }, providers });
    expect(container).toHaveAttribute('data-urgency', 'upcoming');
    expect(container).toHaveTextContent('—');
    expect(container).not.toHaveAttribute('tabindex');
  });
});
