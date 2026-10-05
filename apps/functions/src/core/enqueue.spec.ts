import { cloudTasks, enqueue, isDuplicateTask, taskId } from './enqueue';

const queued = vi.hoisted(() => ({ calls: [] as unknown[][], fail: undefined as unknown }));

vi.mock('firebase-admin/functions', () => ({
  getFunctions: () => ({
    taskQueue: (name: string) => ({
      enqueue: async (payload: unknown, options: unknown) => {
        queued.calls.push([name, payload, options]);
        if (queued.fail) throw queued.fail;
      },
    }),
  }),
}));
vi.mock('./admin', () => ({ adminApp: () => ({}) }));

describe('enqueue', () => {
  beforeEach(() => {
    queued.calls = [];
    queued.fail = undefined;
  });

  it('enqueues on the function’s queue with a hashed id and an optional schedule', async () => {
    const at = new Date('2026-10-05T20:00:00.000Z');
    await cloudTasks.enqueue('notifications-deliver', { a: 1 }, { dedupeKey: 'k', scheduleTime: at });
    await enqueue('system-recordEcho', { b: 2 });
    expect(queued.calls).toEqual([
      [
        'locations/australia-southeast1/functions/notifications-deliver',
        { a: 1 },
        { scheduleTime: at, id: taskId('k') },
      ],
      ['locations/australia-southeast1/functions/system-recordEcho', { b: 2 }, {}],
    ]);
  });

  it('treats an existing task with the same dedupe key as done', async () => {
    queued.fail = Object.assign(new Error('exists'), { code: 'functions/task-already-exists' });
    await expect(enqueue('q', {}, { dedupeKey: 'k' })).resolves.toBeUndefined();
    // Without a key it can't be a duplicate; other errors still throw.
    await expect(enqueue('q', {})).rejects.toThrow('exists');
    queued.fail = new Error('unavailable');
    await expect(enqueue('q', {}, { dedupeKey: 'k' })).rejects.toThrow('unavailable');
    expect(isDuplicateTask(null)).toBe(false);
  });
});
