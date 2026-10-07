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

  it('describes each stage’s completion criteria', async () => {
    const stages = [
      { id: 'intake', title: 'Intake', description: 'Client recorded' },
      { id: 'grant', title: 'Grant issued', description: 'Grant received from the court' },
    ];
    const { rerender } = await render(MtEstateStepper, { inputs: { stages, current: 'intake' } });
    expect(screen.getByText('. Grant received from the court')).toHaveClass('mt-sr');
    await rerender({ inputs: { stages, current: 'intake', interactive: true } });
    const button = screen.getByRole('button', { name: 'Grant issued' });
    await userEvent.hover(button);
    expect(await screen.findByText('Grant received from the court', {}, { timeout: 2000 })).toBeInTheDocument();
  });

  it('keeps a locked stage focusable but unchoosable, and says why', async () => {
    const select = vi.fn();
    const stages = [
      { id: 'intake', title: 'Intake', description: 'Client recorded', locked: 'Only a lawyer can move a matter back' },
      { id: 'grant', title: 'Grant issued' },
    ];
    await render(MtEstateStepper, {
      inputs: { stages, current: 'grant', interactive: true },
      on: { stageSelect: select },
    });
    const button = screen.getByRole('button', { name: 'Intake, complete' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(button);
    expect(select).not.toHaveBeenCalled();
    await userEvent.hover(button);
    expect(
      await screen.findByText('Client recorded. Only a lawyer can move a matter back', {}, { timeout: 2000 }),
    ).toBeInTheDocument();
  });

  const LOCKED = [...STAGES, { id: 'grant', title: 'Grant', locked: 'Only a lawyer can skip ahead' }];

  it('is a track with the current stage named under it when compact (phones, MOB-02)', async () => {
    const { container } = await render(MtEstateStepper, {
      inputs: { stages: LOCKED, current: 'notice', compact: true },
    });
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByRole('group', { name: 'Matter stages' })).toHaveTextContent('Stage 2 of 4 · Notice period');
    const bars = [...container.querySelectorAll('.mt-stepper-bars i')].map((bar) => bar.getAttribute('data-state'));
    expect(bars).toEqual(['done', 'current', null, null]);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('moves the stage from a menu when compact and interactive', async () => {
    const select = vi.fn();
    await render(MtEstateStepper, {
      inputs: { stages: LOCKED, current: 'notice', compact: true, interactive: true },
      on: { stageSelect: select },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Stage 2 of 4 · Notice period. Change stage' }));
    expect(await screen.findByRole('menu', { name: 'Move the matter to' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Notice period' })).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('menuitem', { name: /^Grant/ })).toHaveTextContent('Only a lawyer can skip ahead');
    await userEvent.click(screen.getByRole('menuitem', { name: 'Filing' }));
    expect(select).toHaveBeenCalledWith(STAGES[2]);
  });

  it('says when a compact stepper has no stage yet', async () => {
    await render(MtEstateStepper, { inputs: { stages: STAGES, current: null, compact: true } });
    expect(screen.getByRole('group', { name: 'Matter stages' })).toHaveTextContent('No stage yet');
  });
});
