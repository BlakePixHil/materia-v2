import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { DomainError, FEEDBACK_CALLABLES } from '@materia/domain';
import { DialogService } from '@materia/ui';

import { FEEDBACK_LIMIT_COPY, HelpDialog, type HelpDialogData } from './help-dialog';
import { RELEASE } from '../../../environments/version';
import { CALLABLES } from '../../core/data/callables';

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** Help & feedback (SEC-08). Every message here is fictional. */
describe('HelpDialog', () => {
  afterEach(() => document.querySelectorAll('.mt-overlay').forEach((node) => node.remove()));

  async function open(
    answer: () => Promise<unknown> = async () => ({ feedbackId: 'fb-1', emailed: true }),
    page = '/matters/m-1/notes',
  ) {
    const calls: { name: string; data: Record<string, unknown>; options: unknown }[] = [];
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: CALLABLES,
          useValue: {
            call: async (name: string, data: Record<string, unknown>, options: unknown) => {
              calls.push({ name, data, options });
              return answer();
            },
          },
        },
      ],
    });
    const handle = TestBed.inject(DialogService).open<HelpDialogData, unknown>(HelpDialog, { data: { page } });
    await settle();
    const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement;
    const text = () => dialog().textContent?.replace(/\s+/g, ' ') ?? '';
    const type = async (value: string) => {
      const textarea = dialog().querySelector('textarea') as HTMLTextAreaElement;
      textarea.value = value;
      textarea.dispatchEvent(new Event('input'));
      await settle();
    };
    const choose = async (label: string) => {
      const choice = [...dialog().querySelectorAll('.mt-choice')].find((node) => node.textContent?.includes(label));
      (choice?.querySelector('button') as HTMLButtonElement).click();
      await settle();
    };
    const send = async () => {
      (dialog().querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }));
      await settle();
      await settle();
    };
    return { handle, calls, dialog, text, type, choose, send };
  }

  it('offers what to read and the three kinds of message', async () => {
    const { dialog, text } = await open();
    expect(text()).toContain('Help & feedback');
    const links = [...dialog().querySelectorAll('.mt-help-links a')].map((a) => [
      a.textContent?.trim(),
      a.getAttribute('href'),
    ]);
    // Clerk is off here, so its guide isn't offered.
    expect(links).toEqual([
      ['Accessibility', '/legal/accessibility'],
      ['Privacy and terms', '/legal'],
    ]);
    expect([...dialog().querySelectorAll('.mt-choice')].map((node) => node.textContent?.trim())).toEqual([
      'Something isn’t working',
      'An idea',
      'A question',
    ]);
    expect(text()).toContain('Leave out clients’ details.');
  });

  it('needs a message before it sends', async () => {
    const { calls, text, type, send } = await open();
    await type('   ');
    await send();
    expect(calls).toEqual([]);
    expect(text()).toContain('Write a message');
  });

  it('sends the kind, the message, the page without its query and the version, then closes', async () => {
    const { calls, handle, choose, type, send } = await open(undefined, '/contacts?q=Smith');
    await choose('An idea');
    await type('  A darker sidebar, please.  ');
    await send();
    expect(calls).toEqual([
      {
        name: FEEDBACK_CALLABLES.submit,
        data: {
          kind: 'idea',
          body: 'A darker sidebar, please.',
          page: '/contacts',
          version: `${RELEASE.version}+${RELEASE.sha}`,
        },
        options: { idempotent: true },
      },
    ]);
    await expect(handle.result).resolves.toEqual({ feedbackId: 'fb-1', emailed: true });
  });

  it('says so when the person has sent too many, and keeps what they wrote', async () => {
    const { text, type, send, dialog } = await open(async () => {
      throw new DomainError('RATE_LIMITED', 'Too many messages to support in the last hour');
    });
    await type('One more thing.');
    await send();
    expect(text()).toContain(FEEDBACK_LIMIT_COPY);
    expect((dialog().querySelector('textarea') as HTMLTextAreaElement).value).toBe('One more thing.');
  });
});
