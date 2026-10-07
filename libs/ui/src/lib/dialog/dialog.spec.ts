import { Component, inject } from '@angular/core';
import { render, screen, waitFor, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';

import { DialogService, injectDialogRef, MtDialog, MtDialogTrigger } from './dialog';
import { MtButton } from '../button/button';
import { MT_MENU } from '../menu/menu';

interface RenameData {
  name: string;
}

@Component({
  imports: [MtDialog, MtButton, ...MT_MENU],
  template: `
    <mt-dialog title="Rename the matter" description="The matter number stays the same.">
      <button type="button" [mtMenuTrigger]="more">More options</button>
      <ng-template #more>
        <mt-menu><button mtMenuItem>Copy number</button></mt-menu>
      </ng-template>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" (click)="ref.close()">Cancel</button>
        <button mtButton variant="primary" (click)="ref.close(ref.data.name + ' (renamed)')">Rename</button>
      </ng-container>
    </mt-dialog>
  `,
})
class RenameDialog {
  protected readonly ref = injectDialogRef<RenameData, string>();
}

@Component({
  imports: [MtButton],
  template: `<button mtButton (click)="open()">Rename</button>`,
})
class Opener {
  private readonly dialogs = inject(DialogService);
  result: string | undefined = 'pending';
  async open(): Promise<void> {
    this.result = await this.dialogs.open<RenameData, string>(RenameDialog, {
      data: { name: 'Estate of M. Whitfield' },
    }).result;
  }
}

describe('MtDialog and DialogService', () => {
  // jsdom has no layout, and the focus trap only wraps between visible elements (CDK
  // InteractivityChecker). Give every element a client rect; the Storybook play test covers a real browser.
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([
      new DOMRect(0, 0, 10, 10),
    ] as unknown as DOMRectList);
  });
  afterEach(() => vi.restoreAllMocks());

  it('opens a labelled, described dialog, traps focus, and returns a typed result', async () => {
    const { fixture } = await render(Opener);
    const opener = screen.getByRole('button', { name: 'Rename' });
    await userEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Rename the matter' });
    expect(dialog).toHaveClass('mt-dialog');
    expect(dialog).toHaveAccessibleDescription('The matter number stays the same.');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    // Tab cycles within the dialog.
    for (let i = 0; i < 6; i++) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }

    await userEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(fixture.componentInstance.result).toBe('Estate of M. Whitfield (renamed)'));
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('Escape closes a menu inside the dialog first, then the dialog, and focus returns to the opener', async () => {
    const { fixture } = await render(Opener);
    const opener = screen.getByRole('button', { name: 'Rename' });
    await userEvent.click(opener);
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: 'More options' }));
    await screen.findByRole('menu');

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(fixture.componentInstance.result).toBeUndefined());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('confirm() requires typing the matter number for destructive actions', async () => {
    @Component({ template: `<button type="button" (click)="ask()">Delete</button>` })
    class Asker {
      private readonly dialogs = inject(DialogService);
      answer: boolean | null = null;
      async ask(): Promise<void> {
        this.answer = await this.dialogs.confirm({
          title: 'Delete WE-142?',
          body: 'The matter and its documents are deleted after 30 days.',
          confirmLabel: 'Delete matter',
          tone: 'danger',
          typedConfirmation: 'WE-142',
        });
      }
    }
    const { fixture } = await render(Asker);
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete WE-142?' });
    const confirm = screen.getByRole('button', { name: 'Delete matter' });
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute('data-variant', 'danger');

    await userEvent.type(screen.getByRole('textbox', { name: 'Type WE-142 to confirm' }), 'WE-14');
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox'), '2');
    await waitFor(() => expect(confirm).toBeEnabled());
    await userEvent.click(confirm);
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await waitFor(() => expect(fixture.componentInstance.answer).toBe(true));
  });

  describe('a body that scrolls (WCAG 2.1.1)', () => {
    /** Opens the shortcut sheet with a body `height` px tall in 300 px (jsdom has no layout). */
    async function openSheet(height: number): Promise<HTMLElement> {
      vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('mt-dialog-b') ? height : 0;
      });
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('mt-dialog-b') ? 300 : 0;
      });
      await render(
        `<button type="button" [mtDialogTrigger]="tpl">Open</button>
         <ng-template #tpl><mt-dialog title="Keyboard shortcuts" size="lg"><p>⌘K opens the palette.</p></mt-dialog></ng-template>`,
        { imports: [MtDialog, MtDialogTrigger] },
      );
      await userEvent.click(screen.getByRole('button', { name: 'Open' }));
      return screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    }

    it('takes focus as a region named for the dialog, so the keyboard can scroll it', async () => {
      const dialog = await openSheet(900);
      const body = await within(dialog).findByRole('region', { name: 'Keyboard shortcuts' });
      expect(body).toHaveClass('mt-dialog-b');
      expect(body).toHaveAttribute('tabindex', '0');
    });

    it('is no extra Tab stop when its content fits', async () => {
      const dialog = await openSheet(200);
      expect(within(dialog).queryByRole('region')).toBeNull();
      expect(dialog.querySelector('.mt-dialog-b')).not.toHaveAttribute('tabindex');
    });
  });

  it('opens a template dialog from a trigger and closes it with the close button', async () => {
    await render(
      `<button type="button" [mtDialogTrigger]="tpl">Open</button>
       <ng-template #tpl><mt-dialog title="Keyboard shortcuts" size="lg"><p>⌘K opens the palette.</p></mt-dialog></ng-template>`,
      { imports: [MtDialog, MtDialogTrigger] },
    );
    const trigger = screen.getByRole('button', { name: 'Open' });
    await userEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(dialog).toHaveAttribute('data-size', 'lg');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('returns focus to a stable container when the opener was re-rendered', async () => {
    @Component({
      imports: [MtButton],
      template: `
        <section aria-label="Deadlines">
          @if (showOpener) {
            <button mtButton (click)="open()">Edit deadline</button>
          }
        </section>
      `,
    })
    class Rerendering {
      private readonly dialogs = inject(DialogService);
      showOpener = true;
      async open(): Promise<void> {
        const handle = this.dialogs.open(RenameDialog, { data: { name: 'x' } });
        this.showOpener = false;
        await handle.result;
      }
    }
    const { fixture } = await render(Rerendering);
    await userEvent.click(screen.getByRole('button', { name: 'Edit deadline' }));
    await screen.findByRole('dialog');
    fixture.detectChanges();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(screen.getByRole('region', { name: 'Deadlines' })).toHaveFocus());
  });
});
