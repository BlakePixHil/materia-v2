import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';

import { MtEstateStepper, stepStates } from './estate-stepper';

const STAGES = [
  { id: 'intake', title: 'Intake' },
  { id: 'notice', title: 'Notice period' },
  { id: 'filing', title: 'Filing' },
];

describe('EstateStepper', () => {
  it('derives states from the current stage or an explicit completed list', () => {
    expect(stepStates(STAGES, 'notice')).toEqual(['done', 'current', 'upcoming']);
    expect(stepStates(STAGES, null)).toEqual(['upcoming', 'upcoming', 'upcoming']);
    expect(stepStates(STAGES, 'filing', ['intake'])).toEqual(['done', 'upcoming', 'current']);
  });

  it('marks the current step, read-only by default', async () => {
    await render(MtEstateStepper, { inputs: { stages: STAGES, current: 'notice' } });
    expect(screen.getByRole('list', { name: 'Matter stages' })).toBeInTheDocument();
    expect(screen.getByText('Notice period').closest('li')).toHaveAttribute('aria-current', 'step');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('emits stageSelect when interactive', async () => {
    const select = vi.fn();
    await render(MtEstateStepper, {
      inputs: { stages: STAGES, current: 'notice', interactive: true },
      on: { stageSelect: select },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Filing' }));
    expect(select).toHaveBeenCalledWith(STAGES[2]);
    expect(screen.getByRole('button', { name: 'Intake, complete' })).toBeInTheDocument();
  });
});
