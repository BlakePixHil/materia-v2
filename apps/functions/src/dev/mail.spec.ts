import { devMailPage } from './mail';
import { memoryFirestore } from '../orgs/testing';

/** The emulator's dev mail preview (FND-20). Every address is fictional. */

const SENT = new Date('2026-10-05T00:00:00.000Z');

function world() {
  return memoryFirestore({
    'emulatorOutbox/mail-1': {
      to: 'ada.fictional@example.com',
      template: 'notification',
      model: {
        title: 'Task assigned to <you>',
        body: 'Lodge the inventory',
        link: 'http://localhost:4200/matters/m1/tasks',
        settingsLink: 'http://localhost:4200/settings',
        kindLabel: 'tasks assigned to you',
      },
      sentAt: SENT,
    },
    'emulatorOutbox/mail-2': { to: 'ben.fictional@example.com', template: 'retired', model: {}, sentAt: SENT },
    'emulatorPushOutbox/push-1': {
      token: 'fake-fcm-token-0001-and-more',
      title: 'A critical deadline',
      link: '/matters/m1',
      sentAt: SENT,
    },
  });
}

describe('devMailPage', () => {
  it('lists captured email (escaped) and pushes', async () => {
    const { status, html } = await devMailPage(world().db, undefined);
    expect(status).toBe(200);
    expect(html).toContain('<a href="?id=mail-1">Task assigned to &lt;you&gt;</a>');
    expect(html).toContain('(unrenderable)');
    expect(html).toContain('ada.fictional@example.com');
    expect(html).toContain('2026-10-05 00:00:00');
    expect(html).toContain('<code>fake-fcm-token-0001-and-</code>');
  });

  it('says so when nothing was captured', async () => {
    const { html } = await devMailPage(memoryFirestore().db, undefined);
    expect(html).toContain('No email yet.');
    expect(html).toContain('No pushes yet.');
  });

  it('shows one email as HTML in a sandboxed frame and as text', async () => {
    const { status, html } = await devMailPage(world().db, 'mail-1');
    expect(status).toBe(200);
    expect(html).toContain('<iframe title="HTML version" sandbox="" srcdoc="');
    expect(html).toContain('Open in Materia: http://localhost:4200/matters/m1/tasks');
    expect(html).not.toContain('<script');
  });

  it('reports a missing or unrenderable email', async () => {
    expect((await devMailPage(world().db, 'nope')).status).toBe(404);
    const broken = await devMailPage(world().db, 'mail-2');
    expect(broken.html).toContain('Template retired failed');
  });
});
