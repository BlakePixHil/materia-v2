import { can, type Action, type Role } from '@materia/domain';

import type { Command } from './command-registry';
import { intentUrl } from './intents';

/** The matter a set of commands acts on. */
export interface MatterCommandTarget {
  id: string;
  number: string;
}

/**
 * A matter's sub-commands (CORE-15): what ⌘K offers after Tab on a matter result, and the open
 * matter's "This matter" commands. Actions with a page of their own go there with an intent
 * (`?do=add-task`), which that tab runs; the rest open the tab. `role` hides what the role can't do
 * (the rules and callables still decide).
 */
export function matterCommands(
  matter: MatterCommandTarget,
  role: Role | null,
  go: (url: string) => unknown,
  group = matter.number,
): Command[] {
  const base = `/matters/${matter.id}`;
  const allowed = (action: Action) => !!role && can(role, action);
  const command = (
    id: string,
    title: string,
    icon: Command['icon'],
    url: string,
    keywords: readonly string[],
    action?: Action,
  ): Command => ({
    id: `matter.${id}`,
    title,
    group,
    icon,
    keywords: [matter.number, ...keywords],
    href: url,
    ...(action ? { when: () => allowed(action) } : {}),
    run: () => go(url),
  });
  return [
    command('add-task', 'Add task', 'plus', intentUrl(`${base}/tasks`, 'add-task'), ['todo', 'new'], 'task.edit'),
    command(
      'add-deadline',
      'Add deadline',
      'calendar',
      intentUrl(`${base}/deadlines`, 'add-deadline'),
      ['date', 'due', 'limitation'],
      'task.edit',
    ),
    command(
      'record-event',
      'Record event',
      'calendar',
      intentUrl(`${base}/deadlines`, 'record-event'),
      ['date of death', 'grant', 'key date'],
      'matter.edit',
    ),
    command(
      'log-time',
      'Log time',
      'timer',
      intentUrl(`${base}/time`, 'log-time'),
      ['time entry', 'record', 'units', 'hours'],
      'time.record',
    ),
    command(
      'upload',
      'Upload document',
      'upload',
      intentUrl(`${base}/documents`, 'upload'),
      ['file', 'pdf', 'attach'],
      'document.upload',
    ),
    command('open', 'Open overview', 'matters', `${base}/overview`, ['matter', 'go']),
    command('tasks', 'Open tasks', 'check-circle', `${base}/tasks`, ['todo']),
    command('deadlines', 'Open deadlines', 'calendar', `${base}/deadlines`, ['dates']),
    command('documents', 'Open documents', 'document', `${base}/documents`, ['files']),
    command('parties', 'Open parties', 'contacts', `${base}/parties`, ['people', 'beneficiaries', 'executors']),
    command('notes', 'Open notes', 'compose', `${base}/notes`, ['file note']),
    command('time', 'Open time', 'timer', `${base}/time`, ['time entries', 'units', 'wip']),
    command(
      'close',
      'Close matter…',
      'archive',
      intentUrl(`${base}/overview`, 'close'),
      ['finish', 'archive', 'status'],
      'matter.close',
    ),
  ];
}
