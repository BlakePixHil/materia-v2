import { ClerkPanel } from './clerk-panel';

describe('ClerkPanel', () => {
  it('resumes the thread last shown on a matter once, after show({ resume: true })', () => {
    const panel = new ClerkPanel();
    panel.rememberThread('m-1', 't-1');
    panel.show();
    expect(panel.takeResume('m-1')).toBeNull();

    panel.close();
    panel.show({ resume: true });
    expect(panel.open()).toBe(true);
    // No matter yet (the page behind is still loading): nothing is used up.
    expect(panel.takeResume(null)).toBeNull();
    expect(panel.takeResume('m-1')).toBe('t-1');
    expect(panel.takeResume('m-1')).toBeNull();
  });

  it('starts a new thread on a matter it has no thread for', () => {
    const panel = new ClerkPanel();
    panel.show({ resume: true });
    expect(panel.takeResume('m-2')).toBeNull();
  });
});
