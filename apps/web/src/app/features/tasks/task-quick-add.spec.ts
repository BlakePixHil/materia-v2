import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { loadQuickAddParser, TaskQuickAdd, type QuickAddTask } from './task-quick-add';
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
  // The parser chunk loads before the line is created, so typed tokens are read straight away.
  await loadQuickAddParser();
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

  it('reads a date typed anywhere, and × drops the date but keeps the words', async () => {
    const { type, key, el, host, fixture } = await setup();
    await type('Do the laundry 14/10/2027');
    expect(el.querySelector('mark[data-kind="due"]')?.textContent).toBe('14/10/2027');
    const drop = el.querySelector<HTMLButtonElement>('button[aria-label="Remove the due date"]');
    expect(drop).not.toBeNull();
    drop?.click();
    await fixture.whenStable();
    expect(el.querySelector('button[aria-label="Remove the due date"]')).toBeNull();
    await key('Enter');
    expect(host.saved).toEqual([{ title: 'Do the laundry 14/10/2027' }]);
  });

  it('saves the typed date, and × on the priority chip clears a typed priority', async () => {
    const { type, key, el, host, fixture } = await setup();
    await type('Lodge the caveat by 3/2/2027 !high');
    el.querySelector<HTMLButtonElement>('button[aria-label="Remove the priority"]')?.click();
    await fixture.whenStable();
    await key('Enter');
    expect(host.saved).toEqual([{ title: 'Lodge the caveat', priority: 'none', dueDate: '2027-02-03' }]);
  });

  it('has buttons to set a due date and a priority by hand', async () => {
    const { el } = await setup();
    expect(el.querySelector('button[aria-label="Set a due date"]')).not.toBeNull();
    expect(el.querySelector('button[aria-label="Set a priority"]')).not.toBeNull();
  });
});
