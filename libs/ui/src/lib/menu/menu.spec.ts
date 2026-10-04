import { Component } from '@angular/core';
import { render, screen, waitFor } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';

import { MT_MENU } from './menu';

@Component({
  imports: [...MT_MENU],
  template: `
    <button type="button" [mtMenuTrigger]="actions">Matter actions</button>
    <ng-template #actions>
      <mt-menu>
        <button mtMenuItem icon="timer" kbd="t" (click)="chosen = 'time'">Record time</button>
        <button mtMenuItem icon="compose">Add note</button>
        <button mtMenuItemCheckbox [(checked)]="pinned">Pinned</button>
        <button mtSubmenuItem icon="arrow-right" [mtSubmenuItem]="move">Move to</button>
        <mt-menu-separator />
        <button mtMenuItem icon="trash" tone="danger" disabled>Delete matter</button>
      </mt-menu>
    </ng-template>
    <ng-template #move>
      <mt-menu>
        <button mtMenuItem>Probate</button>
        <button mtMenuItem>Estate administration</button>
      </mt-menu>
    </ng-template>
  `,
})
class Host {
  chosen = '';
  pinned = false;
}

describe('MtMenu', () => {
  it('opens from the trigger with icons, shortcut hints, tones and a separator', async () => {
    await render(Host);
    await userEvent.click(screen.getByRole('button', { name: 'Matter actions' }));
    const menu = await screen.findByRole('menu');
    expect(menu).toHaveClass('mt-menu');
    expect(screen.getByRole('menuitem', { name: /Record time/ })).toHaveClass('mt-menu-item');
    expect(screen.getByRole('menuitem', { name: /Record time/ }).querySelector('kbd')).toHaveTextContent('T');
    expect(screen.getByRole('menuitem', { name: 'Delete matter' })).toHaveAttribute('data-tone', 'danger');
    expect(screen.getByRole('separator')).toHaveClass('mt-menu-sep');
  });

  it('moves with arrows and Home/End, skips disabled items, and activates with Enter', async () => {
    const { fixture } = await render(Host);
    screen.getByRole('button', { name: 'Matter actions' }).focus();
    await userEvent.keyboard('{Enter}');
    await screen.findByRole('menu');
    await waitFor(() => expect(screen.getByRole('menuitem', { name: /Record time/ })).toHaveFocus());
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Add note' })).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('menuitem', { name: /Move to/ })).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(screen.getByRole('menuitem', { name: /Record time/ })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(fixture.componentInstance.chosen).toBe('time');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('toggles a checkbox item without closing the menu', async () => {
    const { fixture } = await render(Host);
    await userEvent.click(screen.getByRole('button', { name: 'Matter actions' }));
    const pinned = await screen.findByRole('menuitemcheckbox', { name: 'Pinned' });
    await userEvent.click(pinned);
    expect(fixture.componentInstance.pinned).toBe(true);
    expect(pinned).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('ArrowLeft closes only the submenu; Escape closes the menu and focus returns to the trigger', async () => {
    await render(Host);
    const trigger = screen.getByRole('button', { name: 'Matter actions' });
    await userEvent.click(trigger);
    const moveTo = await screen.findByRole('menuitem', { name: /Move to/ });
    moveTo.focus();
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(screen.getAllByRole('menu')).toHaveLength(2));

    await userEvent.keyboard('{ArrowLeft}');
    await waitFor(() => expect(screen.getAllByRole('menu')).toHaveLength(1));
    await waitFor(() => expect(moveTo).toHaveFocus());

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
