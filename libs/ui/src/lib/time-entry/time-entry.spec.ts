import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';

import { MtTimeEntry, type TimeEntryVm } from './time-entry';

const MANUAL: TimeEntryVm = {
  id: 'e1',
  description: 'Drafted probate summons',
  meta: 'WE-142 · 1 Oct',
  minutes: 108,
  amountCents: 79200,
  source: 'manual',
};

describe('MtTimeEntry', () => {
  it('shows units and value, with projected actions for a recorded entry', async () => {
    const { container } = await render(
      `<mt-time-entry [entry]="entry"><button type="button">More</button></mt-time-entry>`,
      {
        imports: [MtTimeEntry],
        componentProperties: { entry: MANUAL },
      },
    );
    expect(container).toHaveTextContent('1.8 h');
    expect(container).toHaveTextContent('$792.00');
    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument();
  });

  it('offers Accept for a captured entry, with fixed fee and custom units', async () => {
    const accept = vi.fn();
    const { container } = await render(MtTimeEntry, {
      inputs: {
        entry: {
          id: 'e2',
          description: 'Conference re attorneys',
          minutes: 25,
          fixedFee: true,
          source: 'captured',
          unit: 15,
          rounding: 'nearest',
        },
      },
      on: { accept },
    });
    expect(container).toHaveAttribute('data-source', 'captured');
    expect(container).toHaveTextContent('0.5 h');
    expect(container).toHaveTextContent('Fixed fee');
    await userEvent.click(screen.getByRole('button', { name: 'Accept: Conference re attorneys' }));
    expect(accept).toHaveBeenCalled();
  });

  it('shows an em dash for no amount', async () => {
    const { container } = await render(MtTimeEntry, { inputs: { entry: { ...MANUAL, amountCents: null } } });
    expect(container).toHaveTextContent('—');
  });

  it('shows recorded units and a value label as given (BILL-01)', async () => {
    const { container } = await render(MtTimeEntry, {
      inputs: { entry: { ...MANUAL, minutes: 20, units: 3, valueLabel: 'Non-billable' } },
    });
    expect(container).toHaveTextContent('0.3 h');
    expect(container).toHaveTextContent('Non-billable');
    expect(container).not.toHaveTextContent('$792.00');
  });
});
