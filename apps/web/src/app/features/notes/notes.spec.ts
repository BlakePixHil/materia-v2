import { matterSearchTokens } from '@materia/domain';

import {
  cleanUpOverlays,
  MATTER,
  matterDoc,
  ME,
  meta,
  noteDoc,
  openMatter,
  ORG,
  PARALEGAL,
  PRIYA,
  READONLY,
  type OpenOptions,
} from '../matter-detail/testing';

/** The matter's Notes tab (CORE-13) against the in-memory Firestore and fake `notes-*` callables. Fictional data only. */

afterEach(cleanUpOverlays);

const URL = '/matters/m-whitfield/notes';
type Page = Awaited<ReturnType<typeof openMatter>>;
type Seed = Record<string, unknown>;

const at = (day: number, hour = 1) => new Date(Date.UTC(2026, 9, day, hour));

/** Three notes: an older pinned one, a newer one with mentions, and a migrated one. */
function seedNotes(fs: Page['firestore']): void {
  fs.set(`${MATTER}/notes/n-pinned`, noteDoc('Original will is with Avery.', { pinned: true, createdAt: at(1) }));
  fs.set(
    `${MATTER}/notes/n-call`,
    noteDoc('Called @[user-priya] about #[m-larch] and #[m-secret]. Ask @[user-gone].', {
      createdAt: at(3),
      createdBy: PRIYA,
    }),
  );
  fs.set(
    `${MATTER}/notes/n-legacy`,
    noteDoc('Migrated file note.', { createdAt: at(2), legacyAuthor: 'Morgan Fictional', source: 'migration' }),
  );
  fs.set(`orgs/${ORG}/matters/m-larch`, larch());
  fs.set(
    `orgs/${ORG}/matters/m-secret`,
    matterDoc({ number: 'M-2026-0999', title: 'Secret estate', privileged: true }),
  );
  fs.denyRead(`orgs/${ORG}/matters/m-secret`);
}

/** Another matter `#` can find. */
function larch(data: Seed = {}): Seed {
  return matterDoc({
    number: 'M-2026-0420',
    title: 'Estate of Wilfred Larch',
    search: matterSearchTokens({ number: 'M-2026-0420', title: 'Estate of Wilfred Larch', clientNames: [] }),
    lastActivityAt: at(4),
    ...data,
  });
}

async function open(options: OpenOptions = {}, url = URL) {
  const page = await openMatter(url, {
    ...options,
    configure: (fs, port) => {
      seedNotes(fs);
      options.configure?.(fs, port);
    },
  });
  await page.stable(10);
  return page;
}

const notes = (page: Page) => [...page.body.querySelectorAll<HTMLElement>('mt-matter-notes article[data-note]')];
const noteText = (page: Page) => notes(page).map((note) => page.text(note.querySelector('mt-markdown')));
const article = (page: Page, id: string) =>
  page.body.querySelector<HTMLElement>(`mt-matter-notes article[data-note="${id}"]`) as HTMLElement;
const composer = (page: Page) =>
  page.body.querySelector<HTMLTextAreaElement>('mt-matter-notes .composer textarea') as HTMLTextAreaElement;
const options = (page: Page) =>
  [...page.body.querySelectorAll('[role="listbox"] [role="option"]')].map((o) => page.text(o));
const toasts = (page: Page) => page.text(page.body.querySelector('.mt-toaster, .mt-toast-region'));

/** Types into a textarea: the whole value, the caret at the end (or at `caret`). */
async function type(page: Page, field: HTMLTextAreaElement, value: string, caret = value.length) {
  field.focus();
  field.value = value;
  field.setSelectionRange(caret, caret);
  field.dispatchEvent(new Event('input'));
  await page.stable();
}

const ctrlEnter = (page: Page, field: HTMLElement) => page.press('Enter', { ctrlKey: true }, field);

describe('matter notes tab', () => {
  it('lists pinned notes first, then newest, with authors, mentions and restricted matters', async () => {
    const page = await open();
    expect(page.text(page.body.querySelector('mt-matter-notes h2'))).toBe('Notes');
    expect(noteText(page)).toEqual([
      'Original will is with Avery.',
      'Called @Priya Shah about M-2026-0420 Estate of Wilfred Larch and Restricted matter. Ask Former member.',
      'Migrated file note.',
    ]);
    const [pinned, call, legacy] = notes(page) as [HTMLElement, HTMLElement, HTMLElement];
    expect(page.text(pinned.querySelector('header'))).toContain('Jordan Price');
    expect(page.text(pinned.querySelector('header'))).toContain('Pinned');
    expect(page.text(call.querySelector('header'))).toContain('Priya Shah');
    expect(page.text(legacy.querySelector('header'))).toContain('Morgan Fictional (imported)');
    // The matter chip links to the matter; the restricted one isn't a link.
    const chip = call.querySelector<HTMLAnchorElement>('a.mt-mention');
    expect(chip?.getAttribute('href')).toBe('/matters/m-larch/overview');
    expect(call.querySelector('[data-kind="restricted"]')).not.toBeNull();
  });

  it('adds a note with @ and # mentions chosen from the list, saving with Ctrl+Enter', async () => {
    const page = await open();
    const field = composer(page);
    await type(page, field, 'Spoke to @priy');
    expect(field.getAttribute('aria-autocomplete')).toBe('list');
    expect(options(page)).toEqual(['Priya ShahOwner']);
    expect(field.getAttribute('aria-activedescendant')).toMatch(/-mention-0$/);
    await page.press('Enter', {}, field);
    expect(field.value).toBe('Spoke to @[user-priya] ');
    expect(page.body.querySelector('[role="listbox"]')).toBeNull();

    // `#` searches matters by number or title once typing pauses.
    await type(page, field, `${field.value}about #wil`);
    await page.stable(200);
    expect(options(page)).toEqual(['Estate of Wilfred LarchM-2026-0420']);
    await page.press('Tab', {}, field);
    expect(field.value).toBe('Spoke to @[user-priya] about #[m-larch] ');

    await ctrlEnter(page, field);
    await page.stable(10);
    expect(page.calls('notes-create')).toEqual([
      expect.objectContaining({ matterId: 'm-whitfield', bodyMd: 'Spoke to @[user-priya] about #[m-larch] ' }),
    ]);
    expect(page.calls('notes-create')[0]?.['privileged']).toBe(false);
    expect(field.value).toBe('');
    expect(noteText(page)).toContain('Spoke to @Priya Shah about M-2026-0420 Estate of Wilfred Larch');
    expect(toasts(page)).toContain('Note added');
  });

  it('closes the list with Escape and only offers active members', async () => {
    const page = await open({
      configure: (fs) =>
        fs.set(`orgs/${ORG}/members/user-susp`, {
          displayName: 'Pria Suspended',
          email: 'susp@example.test',
          role: 'lawyer',
          status: 'suspended',
        }),
    });
    const field = composer(page);
    // "pri" matches Priya and Jordan Price (a word of the name), not the suspended member.
    await type(page, field, '@pri');
    expect(options(page)).toEqual(['Jordan PriceLawyer', 'Priya ShahOwner']);
    await page.press('Escape', {}, field);
    expect(page.body.querySelector('[role="listbox"]')).toBeNull();
    // An email address isn't a mention.
    await type(page, field, 'mail avery@pri');
    expect(page.body.querySelector('[role="listbox"]')).toBeNull();
  });

  it('keeps the list while another window has focus, and closes it when the field loses focus', async () => {
    const page = await open();
    const field = composer(page);
    await type(page, field, '@pri');
    // Switching windows blurs the field while the document has no focus.
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    field.dispatchEvent(new FocusEvent('blur'));
    await page.stable();
    expect(options(page)).toEqual(['Jordan PriceLawyer', 'Priya ShahOwner']);
    hasFocus.mockReturnValue(true);
    field.dispatchEvent(new FocusEvent('blur'));
    await page.stable();
    expect(page.body.querySelector('[role="listbox"]')).toBeNull();
  });

  it('pastes plain text only, and formats the selection from the toolbar', async () => {
    const page = await open();
    const field = composer(page);
    await type(page, field, 'Will ');
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        getData: (type: string) =>
          type === 'text/plain' ? 'located\r\nat the bank' : '<b onclick="alert(1)">located</b><img src=x>',
      },
    });
    field.setSelectionRange(5, 5);
    field.dispatchEvent(paste);
    await page.stable();
    expect(paste.defaultPrevented).toBe(true);
    expect(field.value).toBe('Will located\nat the bank');

    field.setSelectionRange(0, 4);
    await page.click('Bold');
    expect(field.value).toBe('**Will** located\nat the bank');
    await page.press('i', { ctrlKey: true }, field);
    expect(field.value).toBe('***Will*** located\nat the bank');
    field.setSelectionRange(field.value.length, field.value.length);
    await page.click('Bulleted list');
    expect(field.value).toBe('***Will*** located\n- at the bank');
  });

  it('shows the size and refuses a note over 100 KB', async () => {
    const page = await open();
    const field = composer(page);
    await type(page, field, 'Short note');
    expect(page.text(page.body.querySelector('mt-matter-notes .composer .size'))).toBe('0.0 KB of 100 KB');
    await type(page, field, 'x'.repeat(100_001));
    const editor = page.body.querySelector('mt-matter-notes .composer') as HTMLElement;
    expect(page.text(editor)).toContain('This note is 100 KB, over the 100 KB limit');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(page.buttons('Add note', editor)[0]?.hasAttribute('disabled')).toBe(true);
    await ctrlEnter(page, field);
    expect(page.calls('notes-create')).toEqual([]);
  });

  it('warns about mentions who can’t open a privileged note, and says who wasn’t notified', async () => {
    const page = await open();
    const field = composer(page);
    await type(page, field, 'Privileged advice for @[user-daniel] and @[user-priya]');
    const editor = page.body.querySelector('mt-matter-notes .composer') as HTMLElement;
    expect(page.text(editor)).not.toContain('won’t be notified');
    (editor.querySelector('mt-checkbox button') as HTMLElement).click();
    await page.stable();
    expect(page.text(editor)).toContain('Daniel Kim can’t open privileged notes, so they won’t be notified.');
    await ctrlEnter(page, field);
    await page.stable(10);
    expect(page.calls('notes-create')[0]).toMatchObject({ privileged: true });
    expect(toasts(page)).toContain('Note added. Daniel Kim wasn’t notified');
  });

  it('makes every note privileged on a privileged matter', async () => {
    const page = await open({ matter: { privileged: true } });
    const editor = page.body.querySelector('mt-matter-notes .composer') as HTMLElement;
    expect(page.text(editor)).toContain('Notes on a privileged matter are always privileged.');
    await type(page, composer(page), 'For @[user-sam]');
    expect(page.text(editor)).toContain('Sam Lee can’t open privileged notes');
  });

  it('edits a note with the version it started from, showing “edited” and its history', async () => {
    const page = await open();
    await page.click('Edit note', article(page, 'n-pinned'));
    const field = article(page, 'n-pinned').querySelector('textarea') as HTMLTextAreaElement;
    expect(field.value).toBe('Original will is with Avery.');
    expect(document.activeElement).toBe(field);
    await type(page, field, 'Original will is with Avery, in the safe.');
    await ctrlEnter(page, field);
    await page.stable(10);
    expect(page.calls('notes-update')).toEqual([
      expect.objectContaining({
        noteId: 'n-pinned',
        bodyMd: 'Original will is with Avery, in the safe.',
        expectedUpdatedAt: meta.updatedAt.toISOString(),
      }),
    ]);
    expect(page.calls('notes-update')[0]?.['overwrite']).toBeUndefined();
    expect(article(page, 'n-pinned').querySelector('textarea')).toBeNull();
    expect(toasts(page)).toContain('Note saved');

    // "edited" opens the history: the earlier version.
    const edited = article(page, 'n-pinned').querySelector<HTMLElement>('button.edited');
    expect(edited?.getAttribute('aria-label')).toMatch(/^Edited .+\. Show history$/);
    edited?.click();
    await vi.waitFor(() => expect(page.text(page.dialog())).toContain('Note history'));
    await page.stable(10);
    expect(page.text(page.dialog())).toContain('Original will is with Avery.');
  });

  it('cancels an edit with Escape', async () => {
    const page = await open();
    await page.click('Edit note', article(page, 'n-pinned'));
    const field = article(page, 'n-pinned').querySelector('textarea') as HTMLTextAreaElement;
    await type(page, field, 'Changed my mind');
    await page.press('Escape', {}, field);
    expect(article(page, 'n-pinned').querySelector('textarea')).toBeNull();
    expect(page.calls('notes-update')).toEqual([]);
  });

  describe('a note changed by someone else while editing', () => {
    async function conflicted() {
      const page = await open();
      // The dialogs load on demand: load them first so the dialog is open when the save returns.
      await import('./note-dialogs');
      await page.click('Edit note', article(page, 'n-pinned'));
      const field = article(page, 'n-pinned').querySelector('textarea') as HTMLTextAreaElement;
      await type(page, field, 'My draft');
      // Priya saves first.
      page.firestore.set(`${MATTER}/notes/n-pinned`, {
        ...page.firestore.get(`${MATTER}/notes/n-pinned`),
        bodyMd: 'Priya’s version',
        updatedAt: at(4, 2),
        updatedBy: PRIYA,
      });
      await ctrlEnter(page, field);
      await page.stable(10);
      return page;
    }

    it('asks, and overwrites theirs', async () => {
      const page = await conflicted();
      expect(page.text(page.dialog())).toContain('This note changed since you started editing');
      expect(page.text(page.dialog())).toContain('Last changed by Priya Shah');
      await page.click('Save mine anyway', page.dialog() as HTMLElement);
      await page.stable(10);
      const calls = page.calls('notes-update');
      expect(calls).toHaveLength(2);
      expect(calls[1]).toMatchObject({ bodyMd: 'My draft', overwrite: true });
      expect(page.firestore.get(`${MATTER}/notes/n-pinned`)?.['bodyMd']).toBe('My draft');
    });

    it('reloads theirs and keeps the draft to merge', async () => {
      const page = await conflicted();
      await page.click('Reload theirs and merge', page.dialog() as HTMLElement);
      await page.stable(10);
      const note = article(page, 'n-pinned');
      const field = note.querySelector('textarea') as HTMLTextAreaElement;
      expect(field.value).toBe('My draft');
      expect(page.text(note.querySelector('[aria-label="Their version"]'))).toContain('Priya’s version');
      await type(page, field, 'My draft, merged with Priya’s version');
      await ctrlEnter(page, field);
      await page.stable(10);
      const calls = page.calls('notes-update');
      expect(calls[1]).toMatchObject({
        bodyMd: 'My draft, merged with Priya’s version',
        expectedUpdatedAt: at(4, 2).toISOString(),
      });
      expect(calls[1]?.['overwrite']).toBeUndefined();
      expect(page.firestore.get(`${MATTER}/notes/n-pinned`)?.['bodyMd']).toBe('My draft, merged with Priya’s version');
    });

    it('explains a pin made elsewhere: it may only have been pinned', async () => {
      const page = await open();
      await import('./note-dialogs');
      await page.click('Edit note', article(page, 'n-call'));
      const field = article(page, 'n-call').querySelector('textarea') as HTMLTextAreaElement;
      await type(page, field, 'My draft');
      // The reader pinned it in another tab: only `pinned` and `updatedAt` moved.
      page.firestore.set(`${MATTER}/notes/n-call`, {
        ...page.firestore.get(`${MATTER}/notes/n-call`),
        pinned: true,
        updatedAt: at(4, 3),
        updatedBy: ME,
      });
      await ctrlEnter(page, field);
      await page.stable(10);
      const dialog = page.text(page.dialog());
      expect(dialog).toContain('Last changed by You');
      expect(dialog).toContain('only pinned or unpinned');
      await page.click('Save mine anyway', page.dialog() as HTMLElement);
      await page.stable(10);
      expect(page.firestore.get(`${MATTER}/notes/n-call`)).toMatchObject({ bodyMd: 'My draft', pinned: true });
    });

    it('keeps editing when the dialog is dismissed', async () => {
      const page = await conflicted();
      await page.click('Keep editing', page.dialog() as HTMLElement);
      await page.stable(10);
      expect((article(page, 'n-pinned').querySelector('textarea') as HTMLTextAreaElement).value).toBe('My draft');
      expect(page.calls('notes-update')).toHaveLength(1);
    });
  });

  it('scrolls to, highlights and focuses the note a mention link points at', async () => {
    const page = await open({}, `${URL}#note-n-legacy`);
    const target = article(page, 'n-legacy');
    expect(target.id).toBe('note-n-legacy');
    expect(target.hasAttribute('data-highlight')).toBe(true);
    expect(document.activeElement).toBe(target);
    expect(target.getAttribute('tabindex')).toBe('0');
    expect(notes(page).filter((note) => note.hasAttribute('data-highlight'))).toHaveLength(1);
    // Moving on clears it.
    article(page, 'n-call').focus();
    await page.stable();
    expect(target.hasAttribute('data-highlight')).toBe(false);
  });

  it('says so when a mention link points at a note that’s gone', async () => {
    const page = await open({}, `${URL}#note-n-missing`);
    expect(toasts(page)).toContain('That note isn’t here');
    expect(notes(page).some((note) => note.hasAttribute('data-highlight'))).toBe(false);
  });

  it('pins and unpins, and deletes with Undo', async () => {
    const page = await open();
    await page.click('Pin note', article(page, 'n-call'));
    expect(page.firestore.get(`${MATTER}/notes/n-call`)).toMatchObject({ pinned: true, updatedBy: ME });
    // Pinned ones first: the newer pinned note moves to the top.
    expect(notes(page).map((n) => n.dataset['note'])).toEqual(['n-call', 'n-pinned', 'n-legacy']);
    await page.click('Unpin note', article(page, 'n-call'));
    expect(page.firestore.get(`${MATTER}/notes/n-call`)?.['pinned']).toBe(false);

    await page.click('Delete note', article(page, 'n-legacy'));
    expect(page.firestore.get(`${MATTER}/notes/n-legacy`)).toMatchObject({ deletedBy: ME });
    expect(notes(page).map((n) => n.dataset['note'])).toEqual(['n-pinned', 'n-call']);
    expect(toasts(page)).toContain('Note deleted');
    await page.click('Undo');
    await page.stable(10);
    expect(page.firestore.get(`${MATTER}/notes/n-legacy`)).toMatchObject({ deletedAt: null, deletedBy: null });
    expect(notes(page)).toHaveLength(3);
  });

  it('moves between notes with j and k, edits with e and pins with p', async () => {
    const page = await open();
    await page.press('j');
    expect(document.activeElement).toBe(article(page, 'n-pinned'));
    await page.press('j');
    expect(document.activeElement).toBe(article(page, 'n-call'));
    await page.press('p');
    expect(page.firestore.get(`${MATTER}/notes/n-call`)?.['pinned']).toBe(true);
    await page.press('k');
    await page.press('e');
    expect(document.activeElement?.tagName).toBe('TEXTAREA');
    await page.press('Escape', {}, document.activeElement as HTMLElement);
    // c writes a new note.
    await page.press('c');
    expect(document.activeElement).toBe(composer(page));
  });

  it('shows a paralegal only notes they may read, without the privileged option', async () => {
    const page = await open({
      session: PARALEGAL,
      configure: (fs) =>
        fs.set(`${MATTER}/notes/n-priv`, noteDoc('Privileged advice', { privileged: true, createdAt: at(4) })),
    });
    expect(noteText(page)).not.toContain('Privileged advice');
    expect(notes(page)).toHaveLength(3);
    expect(page.body.querySelector('mt-matter-notes .composer mt-checkbox')).toBeNull();
    await type(page, composer(page), 'Paralegal note');
    await ctrlEnter(page, composer(page));
    await page.stable(10);
    expect(page.calls('notes-create')[0]).not.toHaveProperty('privileged');
  });

  it('is read-only for the readonly role', async () => {
    const page = await open({ session: READONLY });
    expect(notes(page)).toHaveLength(3);
    expect(page.body.querySelector('mt-matter-notes .composer')).toBeNull();
    expect(page.buttons('Edit note')).toEqual([]);
    expect(page.buttons('Pin note')).toEqual([]);
  });

  it('keeps the draft and says why when a save fails', async () => {
    const page = await open({
      callables: {
        'notes-create': () => {
          throw { code: 'functions/failed-precondition', details: { code: 'FAILED_PRECONDITION' } };
        },
      },
    });
    const field = composer(page);
    await type(page, field, 'A note that won’t save');
    await ctrlEnter(page, field);
    await page.stable(10);
    expect(field.value).toBe('A note that won’t save');
    expect(toasts(page)).toContain('The note didn’t save');
  });
});
