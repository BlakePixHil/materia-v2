import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { TaskQuickAdd, type QuickAddTask } from './task-quick-add';
import type { TaskPerson } from './task-view';

/** The quick-add line (CORE-08). Fictional people only. */

@Component({
  imports: [TaskQuickAdd],
  template: `<mt-task-quick-add
    [members]="members()"
    [personal]="personal()"
    (saved)="saved.push($event)"
    (closed)="closed = closed + 1"
  />`,
})
class Host {
  readonly members = signal<readonly TaskPerson[]>([
    { uid: 'u-jordan', name: 'Jordan Price' },
    { uid: 'u-jo', name: 'Jo Marsh' },
    { uid: 'u-priya', name: 'Priya Shah' },
  ]);
  readonly personal = signal(false);
  saved: QuickAddTask[] = [];
  closed = 0;
}

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup(personal = false) {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.personal.set(personal);
  await fixture.whenStable();
  await settle();
  const el = fixture.nativeElement as HTMLElement;
  const field = el.querySelector('input') as HTMLInputElement;
  const type = async (text: string) => {
    field.value = text;
    field.dispatchEvent(new Event('input'));
    await settle();
    await fixture.whenStable();
  };
  const key = async (key: string) => {
    field.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    await fixture.whenStable();
  };
  const text = () => el.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  return { fixture, el, field, type, key, text, host: fixture.componentInstance };
}

describe('TaskQuickAdd', () => {
  it('focuses the field and points out a name that could be several people', async () => {
    const { field, type, text, el } = await setup();
    expect(document.activeElement).toBe(field);
    await type('Call the bank @jo');
    expect(text()).toContain('@jo could be Jordan Price or Jo Marsh. Type more of the name.');
    expect(el.querySelector('mark[data-kind="unresolved"]')?.textContent).toBe('@jo');
  });

  it('asks for a title, then saves and clears the line', async () => {
    const { type, key, text, host, field } = await setup();
    await type('   ');
    await key('Enter');
    expect(text()).toContain('Type a title for the task.');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    await type('Send the letter @priya !urgent');
    expect(text()).not.toContain('Type a title');
    await key('Enter');
    expect(host.saved).toEqual([{ title: 'Send the letter', assigneeUid: 'u-priya', priority: 'urgent' }]);
    expect(field.value).toBe('');
  });

  it('keeps @names in the title of a personal task', async () => {
    const { type, key, text, host } = await setup(true);
    expect(text()).toContain('Type !high for priority');
    await type('Coffee with @priya !low');
    expect(text()).not.toContain('could be');
    await key('Enter');
    expect(host.saved[0]).toEqual({ title: 'Coffee with @priya', priority: 'low' });
  });

  it('closes with Escape', async () => {
    const { key, host } = await setup();
    await key('Escape');
    expect(host.closed).toBe(1);
  });

  it('refuses a title over 500 characters', async () => {
    const { type, key, text, host } = await setup();
    await type('x'.repeat(501));
    await key('Enter');
    expect(text()).toContain('Keep the title to 500 characters or fewer.');
    expect(host.saved).toEqual([]);
  });
});
