import { Component, inject } from '@angular/core';
import type { Meta, StoryObj } from '@storybook/angular';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { MtBottomSheet } from '../lib/bottom-sheet/bottom-sheet';
import { MtButton } from '../lib/button/button';
import { type MtCommandGroup, MtCommandPalette, MtCommandPaletteOverlay } from '../lib/command-palette/command-palette';
import { DialogService, MtDialog, MtDialogTrigger } from '../lib/dialog/dialog';
import { MtIconButton } from '../lib/icon-button/icon-button';
import { MT_MENU } from '../lib/menu/menu';
import { ToastService } from '../lib/toast/toast';
import { MtTooltip } from '../lib/tooltip/tooltip';

const body = () => within(document.body);

/** Every overlay. Play functions open them so the a11y checks see the open state. Fictional data only. */
@Component({
  selector: 'mt-overlays-demo',
  imports: [
    ...MT_MENU,
    MtButton,
    MtIconButton,
    MtTooltip,
    MtDialog,
    MtDialogTrigger,
    MtBottomSheet,
    MtCommandPalette,
    MtCommandPaletteOverlay,
  ],
  template: `
    <div class="mt-row mt-wrap" style="gap: 12px">
      <button mtIconButton icon="more" label="Matter actions" variant="secondary" [mtMenuTrigger]="actions"></button>
      <button mtButton iconStart="timer" mtTooltip="Record time" mtTooltipKbd="t">Record time</button>
      <button mtButton [mtDialogTrigger]="publish">Publish notice…</button>
      <button mtButton variant="danger" (click)="confirmDelete()">Delete matter…</button>
      <button mtButton (click)="toast()">Show toasts</button>
      <button mtButton [mtDialogTrigger]="palette">Command palette</button>
      <button mtButton [mtDialogTrigger]="sheet">Bottom sheet</button>
    </div>

    <ng-template #actions>
      <mt-menu>
        <button mtMenuItem icon="timer" kbd="t">Record time</button>
        <button mtMenuItem icon="compose" kbd="n">Add file note</button>
        <button mtMenuItemCheckbox icon="flag" [checked]="true">Pinned</button>
        <button mtSubmenuItem icon="arrow-right" [mtSubmenuItem]="moveTo">Move to stage</button>
        <mt-menu-separator />
        <button mtMenuItem icon="sparkle" tone="ai" kbd="mod+j">Ask Clerk</button>
        <mt-menu-separator />
        <button mtMenuItem icon="trash" tone="danger">Delete matter</button>
      </mt-menu>
    </ng-template>
    <ng-template #moveTo>
      <mt-menu>
        <button mtMenuItem>Grant of probate</button>
        <button mtMenuItem>Estate administration</button>
      </mt-menu>
    </ng-template>

    <ng-template #publish let-close="close">
      <mt-dialog
        title="Publish the notice of intended application?"
        description="It goes to the Supreme Court portal and can’t be withdrawn."
      >
        <button mtButton variant="secondary" [mtMenuTrigger]="actions" mtTooltip="More options for this notice">
          More options
        </button>
        <ng-container mtDialogFooter>
          <button mtButton variant="ghost" (click)="close()">Cancel</button>
          <button mtButton variant="primary" (click)="close()">Publish notice</button>
        </ng-container>
      </mt-dialog>
    </ng-template>

    <ng-template #palette>
      <mt-command-palette-overlay>
        <mt-command-palette [groups]="groups" query="whitf" />
      </mt-command-palette-overlay>
    </ng-template>

    <ng-template #sheet>
      <mt-bottom-sheet title="Record time">
        <p class="body t-2">Call with Peter Hale about the share registry · 0.2 h</p>
        <button mtButton variant="primary" size="lg">Save entry</button>
      </mt-bottom-sheet>
    </ng-template>
  `,
})
class OverlaysDemo {
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  protected readonly groups: MtCommandGroup[] = [
    {
      label: 'Matters',
      items: [
        { id: 'm1', label: 'Estate of Margaret Whitfield', meta: 'WE-142', icon: 'matters' },
        { id: 'p1', label: 'Catherine Whitfield', meta: '· Executor', icon: 'user' },
      ],
    },
    {
      label: 'Actions',
      items: [
        { id: 'a1', label: 'Record time on WE-142', icon: 'timer', kbd: 't' },
        { id: 'a2', label: 'Publish notice of intended application', icon: 'send' },
        { id: 'c1', label: 'Ask Clerk about “whitf”', icon: 'sparkle', tone: 'ai', kbd: 'mod+j' },
      ],
    },
  ];

  protected confirmDelete(): void {
    void this.dialogs.confirm({
      title: 'Delete WE-142?',
      body: 'The matter, its documents and time entries are deleted after 30 days.',
      confirmLabel: 'Delete matter',
      tone: 'danger',
      typedConfirmation: 'WE-142',
    });
  }

  protected toast(): void {
    this.toasts.show({
      tone: 'success',
      title: 'Notice published',
      description: 'Whitfield · filing opens 16 Oct',
      action: { label: 'Undo', run: () => undefined },
      duration: 0,
    });
    this.toasts.show({
      tone: 'ai',
      title: 'Clerk drafted 6 time entries',
      description: '2.1 h from yesterday’s email and calendar',
      action: { label: 'Review', run: () => undefined },
      duration: 0,
    });
    this.toasts.show({
      tone: 'danger',
      title: 'Couldn’t sync to Outlook',
      description: 'Reconnect your Microsoft account in Settings.',
      duration: 0,
    });
  }
}

const meta: Meta<OverlaysDemo> = {
  title: 'Components/Overlays',
  component: OverlaysDemo,
  parameters: { layout: 'padded' },
};
export default meta;
type Story = StoryObj<OverlaysDemo>;

export const Menu: Story = {
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('button', { name: 'Matter actions' });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const menu = await body().findByRole('menu');
    await waitFor(() => expect(menu).toBeVisible());
    await userEvent.keyboard('{ArrowDown}');
    await expect(body().getByRole('menuitem', { name: /Add file note/ })).toHaveFocus();
  },
};
export const MenuDark: Story = { ...Menu, globals: { theme: 'dark' } };

export const Tooltip: Story = {
  play: async ({ canvasElement }) => {
    within(canvasElement).getByRole('button', { name: 'Record time' }).focus();
    await expect(await body().findByRole('tooltip')).toHaveTextContent('Record time');
  },
};
export const TooltipDark: Story = { ...Tooltip, globals: { theme: 'dark' } };

export const Dialog: Story = {
  play: async ({ canvasElement }) => {
    const opener = within(canvasElement).getByRole('button', { name: 'Publish notice…' });
    await userEvent.click(opener);
    const dialog = await body().findByRole('dialog', { name: /Publish the notice/ });
    // Focus trap in a real browser: Tab and Shift+Tab never leave the dialog.
    for (let i = 0; i < 6; i++) {
      await userEvent.tab();
      await expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await userEvent.tab({ shift: true });
    await expect(dialog.contains(document.activeElement)).toBe(true);
  },
};
export const DialogDark: Story = { ...Dialog, globals: { theme: 'dark' } };

export const DialogFocusRestore: Story = {
  play: async ({ canvasElement }) => {
    const opener = within(canvasElement).getByRole('button', { name: 'Publish notice…' });
    await userEvent.click(opener);
    await body().findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(body().queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  },
};

export const ConfirmTyped: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Delete matter…' }));
    const dialog = await body().findByRole('alertdialog', { name: 'Delete WE-142?' });
    await expect(within(dialog).getByRole('button', { name: 'Delete matter' })).toBeDisabled();
  },
};
export const ConfirmTypedDark: Story = { ...ConfirmTyped, globals: { theme: 'dark' } };

export const StackedOverlays: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Publish notice…' }));
    const dialog = await body().findByRole('dialog');
    const more = within(dialog).getByRole('button', { name: 'More options' });
    more.focus();
    await expect(await body().findByRole('tooltip')).toHaveTextContent('More options for this notice');
    await userEvent.keyboard('{Enter}');
    await body().findByRole('menu');
    // Escape closes the menu only; the dialog stays.
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(body().queryByRole('menu')).toBeNull());
    await expect(body().getByRole('dialog')).toBeVisible();
  },
};

export const Toasts: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Show toasts' }));
    const toast = await body().findByText('Notice published');
    await waitFor(() => expect(toast).toBeVisible());
  },
};
export const ToastsDark: Story = { ...Toasts, globals: { theme: 'dark' } };

export const CommandPalette: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Command palette' }));
    const listbox = await body().findByRole('listbox');
    await waitFor(() => expect(listbox).toBeVisible());
  },
};
export const CommandPaletteDark: Story = { ...CommandPalette, globals: { theme: 'dark' } };

export const BottomSheet: Story = {
  parameters: { viewport: { defaultViewport: 'mobile1' } },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Bottom sheet' }));
    const sheet = await body().findByRole('dialog', { name: 'Record time' });
    await waitFor(() => expect(sheet).toBeVisible());
  },
};
export const BottomSheetDark: Story = { ...BottomSheet, globals: { theme: 'dark' } };
