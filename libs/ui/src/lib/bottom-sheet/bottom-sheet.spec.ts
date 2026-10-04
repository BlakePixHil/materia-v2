import { fireEvent, render, screen, waitFor } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';

import { MtBottomSheet } from './bottom-sheet';
import { MtDialogTrigger } from '../dialog/dialog';

async function openSheet() {
  await render(
    `<button type="button" [mtDialogTrigger]="sheet">Record time</button>
     <ng-template #sheet><mt-bottom-sheet title="Record time"><p>Call with Peter Hale</p></mt-bottom-sheet></ng-template>`,
    { imports: [MtDialogTrigger, MtBottomSheet] },
  );
  await userEvent.click(screen.getByRole('button', { name: 'Record time' }));
  return screen.findByRole('dialog', { name: 'Record time' });
}

describe('MtBottomSheet', () => {
  it('opens at the 50% snap point and toggles height from the handle', async () => {
    const sheet = await openSheet();
    expect(sheet).toHaveClass('mt-sheet');
    await waitFor(() => expect(sheet).toHaveAttribute('data-snap', 'half'));
    await userEvent.click(screen.getByRole('button', { name: 'Expand sheet' }));
    expect(sheet).toHaveAttribute('data-snap', 'full');
    expect(screen.getByRole('button', { name: 'Shrink sheet' })).toBeInTheDocument();
  });

  it('drags up to expand and down to close', async () => {
    const sheet = await openSheet();
    await waitFor(() => expect(sheet).toHaveAttribute('data-snap', 'half'));
    const handle = screen.getByRole('button', { name: 'Expand sheet' });
    fireEvent.pointerDown(handle, { clientY: 500, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    await waitFor(() => expect(sheet).toHaveAttribute('data-snap', 'full'));

    fireEvent.pointerDown(handle, { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 260, pointerId: 1 });
    expect(sheet).toHaveAttribute('data-dragging');
    fireEvent.pointerMove(handle, { clientY: 400, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    await waitFor(() => expect(sheet).toHaveAttribute('data-snap', 'half'));

    fireEvent.pointerDown(handle, { clientY: 400, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 600, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('closes with Escape like any dialog', async () => {
    await openSheet();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
