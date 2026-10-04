import { Component, signal } from '@angular/core';
import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';

import { dateOnly } from '@materia/domain';

import { MtTaskRow, type TaskRowVm } from './task-row';
import { MT_TODAY } from '../pipes/format';

// Fictional sample data, as in the design system.
const TASK: TaskRowVm = {
  id: 't1',
  title: 'Publish notice of intended application',
  done: false,
  subtitle: 'WE-142 · Whitfield',
  matterType: 'probate',
  assignee: { id: 'u1', name: 'Jordan Price' },
  deadline: { due: dateOnly('2026-10-03'), critical: true, trace: 'UCPR r 78.3' },
  priority: 'high',
};

@Component({
  imports: [MtTaskRow],
  template: `<mt-task-row
    [task]="task()"
    [editable]="editable()"
    (done)="events.push('done:' + $event)"
    (titleChange)="events.push('title:' + $event)"
    (open)="events.push('open')"
  />`,
})
class Host {
  readonly task = signal<TaskRowVm>(TASK);
  readonly editable = signal(false);
  readonly events: string[] = [];
}

const setup = () => render(Host, { providers: [{ provide: MT_TODAY, useValue: () => dateOnly('2026-10-03') }] });

describe('MtTaskRow', () => {
  it('shows the title, subtitle, matter tag, deadline, priority and assignee', async () => {
    await setup();
    expect(screen.getByRole('button', { name: TASK.title })).toBeInTheDocument();
    expect(screen.getByText('WE-142 · Whitfield')).toBeInTheDocument();
    expect(screen.getByText('Probate')).toBeInTheDocument();
    expect(screen.getByText('Today').closest('mt-deadline-chip')).toHaveAttribute('data-urgency', 'today');
    expect(screen.getByRole('img', { name: 'High priority' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Jordan Price' })).toBeInTheDocument();
  });

  it('emits done from the checkbox, and marks a done task', async () => {
    const { fixture } = await setup();
    const checkbox = screen.getByRole('checkbox', { name: `Done: ${TASK.title}` });
    expect(checkbox).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(checkbox);
    expect(fixture.componentInstance.events).toEqual(['done:true']);
    fixture.componentInstance.task.set({
      ...TASK,
      done: true,
      priority: 'none',
      matterType: undefined,
      assignee: null,
      deadline: null,
    });
    fixture.detectChanges();
    expect(checkbox).toHaveAttribute('aria-checked', 'true');
    expect(fixture.nativeElement.querySelector('mt-task-row')).toHaveAttribute('data-done');
    await userEvent.click(checkbox);
    expect(fixture.componentInstance.events).toEqual(['done:true', 'done:false']);
  });

  it('opens the task from the title when not editable', async () => {
    const { fixture } = await setup();
    await userEvent.click(screen.getByRole('button', { name: TASK.title }));
    expect(fixture.componentInstance.events).toEqual(['open']);
  });

  it('edits the title inline: Enter saves, Escape cancels, focus returns to the title', async () => {
    const { fixture } = await setup();
    fixture.componentInstance.editable.set(true);
    fixture.detectChanges();
    await userEvent.click(screen.getByRole('button', { name: `Edit title: ${TASK.title}` }));
    const input = await screen.findByRole('textbox', { name: 'Task title' });
    expect(input).toHaveFocus();
    await userEvent.clear(input);
    await userEvent.type(input, 'Publish notice (Daily Telegraph){Enter}');
    expect(fixture.componentInstance.events).toEqual(['title:Publish notice (Daily Telegraph)']);
    await fixture.whenStable();
    expect(screen.getByRole('button', { name: `Edit title: ${TASK.title}` })).toHaveFocus();

    screen.getByRole('button', { name: `Edit title: ${TASK.title}` }).focus();
    await userEvent.keyboard('{Enter}');
    const again = await screen.findByRole('textbox', { name: 'Task title' });
    await userEvent.type(again, ' and more{Escape}');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(fixture.componentInstance.events).toHaveLength(1);
  });

  it("doesn't emit a blank or unchanged title, and saves on blur", async () => {
    const { fixture } = await setup();
    fixture.componentInstance.editable.set(true);
    fixture.detectChanges();
    const title = () => screen.getByRole('button', { name: `Edit title: ${TASK.title}` });
    await userEvent.click(title());
    await userEvent.clear(await screen.findByRole('textbox'));
    await userEvent.keyboard('   {Enter}');
    await userEvent.click(title());
    await userEvent.keyboard('{Enter}');
    expect(fixture.componentInstance.events).toEqual([]);
    await userEvent.click(title());
    await userEvent.type(await screen.findByRole('textbox'), '!');
    await userEvent.tab();
    expect(fixture.componentInstance.events).toEqual([`title:${TASK.title}!`]);
  });
});
