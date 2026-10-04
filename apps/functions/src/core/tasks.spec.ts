import { taskId } from './tasks';

describe('taskId', () => {
  it('hashes dedupe keys into stable Cloud Tasks ids', () => {
    const id = taskId('orgs/org-a/requests/6f1c1c2e');
    expect(id).toMatch(/^[a-f0-9]{40}$/);
    expect(taskId('orgs/org-a/requests/6f1c1c2e')).toBe(id);
    expect(taskId('another key')).not.toBe(id);
  });
});
