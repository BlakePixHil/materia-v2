import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';

import { MT_TOAST_MAX_VISIBLE, ToastService } from './toast';

@Component({ template: `<button type="button">Publish notice</button>` })
class Page {
  readonly toasts = inject(ToastService);
}

const toastTitles = () => [...document.querySelectorAll('.mt-toast .tt')].map((el) => el.textContent);

describe('ToastService', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => {
    vi.useRealTimers();
    document.querySelector('mt-toast-outlet')?.remove();
  });

  async function setup() {
    const view = await render(Page);
    const service = TestBed.inject(ToastService);
    const flush = async () => {
      TestBed.tick();
      await view.fixture.whenStable();
    };
    return { service, flush };
  }

  it('shows a toast with tone, description and action, then hides it after 5 seconds', async () => {
    const { service, flush } = await setup();
    const undo = vi.fn();
    service.show({
      tone: 'success',
      title: 'Notice published',
      description: 'Filing opens 16 Oct',
      action: { label: 'Undo', run: undo },
    });
    await flush();
    const toast = document.querySelector('.mt-toast');
    expect(toast).toHaveAttribute('data-tone', 'success');
    expect(screen.getByText('Filing opens 16 Oct')).toHaveClass('ts');

    await vi.advanceTimersByTimeAsync(4900);
    await flush();
    expect(toastTitles()).toEqual(['Notice published']);
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(toastTitles()).toEqual([]);
    expect(undo).not.toHaveBeenCalled();
  });

  it('keeps at most three on screen and queues the rest', async () => {
    const { service, flush } = await setup();
    for (const title of ['One', 'Two', 'Three', 'Four']) service.show({ title, duration: 1000 });
    await flush();
    expect(toastTitles()).toEqual(['One', 'Two', 'Three']);
    expect(MT_TOAST_MAX_VISIBLE).toBe(3);

    await vi.advanceTimersByTimeAsync(1001);
    await flush();
    expect(toastTitles()).toEqual(['Four']);
  });

  it('pauses timers while hovered and resumes on leave', async () => {
    const { service, flush } = await setup();
    service.show({ title: 'Deadline saved', duration: 1000 });
    await flush();
    await vi.advanceTimersByTimeAsync(600);
    service.pause();
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(toastTitles()).toEqual(['Deadline saved']);
    service.resume();
    await vi.advanceTimersByTimeAsync(300);
    await flush();
    expect(toastTitles()).toEqual(['Deadline saved']);
    await vi.advanceTimersByTimeAsync(150);
    await flush();
    expect(toastTitles()).toEqual([]);
  });

  it('announces politely, and assertively for errors, without taking focus', async () => {
    const { service, flush } = await setup();
    const button = screen.getByRole('button', { name: 'Publish notice' });
    button.focus();
    service.show({ tone: 'success', title: 'Notice published' });
    service.show({ tone: 'danger', title: 'Couldn’t sync to Outlook', description: 'Reconnect your account.' });
    await flush();
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('Notice published');
    expect(document.querySelector('[aria-live="assertive"]')).toHaveTextContent(
      'Couldn’t sync to Outlook. Reconnect your account.',
    );
    expect(button).toHaveFocus();
  });

  it('runs the action and dismisses; F6 reaches the action and F6 again returns focus', async () => {
    const { service, flush } = await setup();
    const review = vi.fn();
    const button = screen.getByRole('button', { name: 'Publish notice' });
    button.focus();
    service.show({ tone: 'ai', title: 'Clerk drafted 6 time entries', action: { label: 'Review', run: review } });
    await flush();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await user.keyboard('{F6}');
    const action = screen.getByRole('button', { name: 'Review' });
    expect(action).toHaveFocus();
    expect(action).toHaveAttribute('data-variant', 'ai');
    await user.keyboard('{F6}');
    expect(button).toHaveFocus();

    await user.click(action);
    await flush();
    expect(review).toHaveBeenCalledTimes(1);
    expect(toastTitles()).toEqual([]);
  });

  it('dismisses with the close button or the returned ref', async () => {
    const { service, flush } = await setup();
    const ref = service.show({ title: 'Saved', duration: 0 });
    service.show({ title: 'Archived', duration: 0 });
    await flush();
    ref.dismiss();
    await flush();
    expect(toastTitles()).toEqual(['Archived']);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await flush();
    expect(toastTitles()).toEqual([]);
  });

  it('fades a dismissed toast out before removing it when motion is allowed', async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === '(prefers-reduced-motion: no-preference)',
      media: query,
    })) as unknown as typeof window.matchMedia;
    try {
      const { service, flush } = await setup();
      const ref = service.show({ title: 'Saved', duration: 0 });
      service.show({ title: 'Archived', duration: 0 });
      await flush();
      ref.dismiss();
      await flush();
      const leaving = document.querySelector('.mt-toast.mt-leave');
      expect(leaving).toHaveTextContent('Saved');
      expect(leaving).toHaveAttribute('inert');
      expect(service.visible().map((t) => t.title)).toEqual(['Archived']);
      await vi.advanceTimersByTimeAsync(150);
      await flush();
      expect(toastTitles()).toEqual(['Archived']);
    } finally {
      window.matchMedia = original;
    }
  });
});
