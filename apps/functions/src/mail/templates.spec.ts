import { renderMail } from './templates';

describe('renderMail', () => {
  const model = {
    orgName: 'Fictional <Bayside> Legal',
    inviterName: 'Priya Fictional',
    role: 'paralegal',
    link: 'https://materia.example/invite/inv-1?token=abc&x=1',
  };

  it('fills the invite template, escaping HTML and keeping a text fallback', () => {
    const mail = renderMail('invite', model);
    expect(mail.subject).toBe('Priya Fictional invited you to Fictional <Bayside> Legal on Materia');
    expect(mail.html).toContain('<strong>Fictional &lt;Bayside&gt; Legal</strong>');
    expect(mail.html).toContain('as a paralegal');
    expect(mail.html).toContain('href="https://materia.example/invite/inv-1?token=abc&amp;x=1"');
    expect(mail.text).toContain('Accept the invitation: https://materia.example/invite/inv-1?token=abc&x=1');
  });

  it('refuses unknown templates and non-http links', () => {
    expect(() => renderMail('nope', {})).toThrow('Unknown mail template');
    expect(() => renderMail('invite', { ...model, link: 'javascript:alert(1)' })).toThrow('http(s)');
    expect(renderMail('invite', { ...model, role: 'mystery', inviterName: null }).text).toContain('as a member');
  });
});

describe('notification and digest templates (FND-20)', () => {
  const notification = {
    title: 'Task assigned to you',
    body: 'Lodge the inventory · BL-2026-0042',
    link: 'https://materia.example/matters/m1/tasks',
    settingsLink: 'https://materia.example/settings',
    kindLabel: 'tasks assigned to you',
    critical: false,
  };

  it('uses the title as the subject, on one line, with the body only in the message', () => {
    const mail = renderMail('notification', { ...notification, title: 'Task assigned\r\nto you' });
    expect(mail.subject).toBe('Task assigned to you');
    expect(mail.subject).not.toContain('inventory');
    expect(mail.html).toContain('<p>Lodge the inventory · BL-2026-0042</p>');
    expect(mail.html).toContain('href="https://materia.example/matters/m1/tasks"');
    expect(mail.html).not.toContain('Needs attention today');
    expect(mail.text).toContain('Open in Materia: https://materia.example/matters/m1/tasks');
    expect(mail.text).toContain('You get this email for tasks assigned to you.');
  });

  it('flags critical notifications and leaves out an empty body', () => {
    const mail = renderMail('notification', { ...notification, critical: true, body: '' });
    expect(mail.html).toContain('Needs attention today');
    expect(mail.text.startsWith('Needs attention today\nTask assigned to you\n')).toBe(true);
    expect(mail.html).not.toContain('<p></p>');
  });

  it('lists today’s and overdue items with their own links, and unread mentions', () => {
    const item = (label: string, extra: Record<string, unknown> = {}) => ({
      label,
      matterNumber: 'BL-2026-0042',
      critical: false,
      dueLabel: '6 Oct 2026',
      link: `https://materia.example/matters/m1/${label.length}`,
      ...extra,
    });
    const mail = renderMail('digest', {
      subject: 'Your day in Materia: 2 due today, 1 overdue, 1 unread mention',
      dateLabel: 'Tuesday 6 October',
      dueToday: [item('File the inventory', { critical: true }), item('Call the executor', { matterNumber: null })],
      overdue: [item('Send the <draft>', { dueLabel: '1 Oct 2026' })],
      unreadMentions: 1,
      unreadMentionsLabel: '1 unread mention',
      inboxLink: 'https://materia.example/inbox',
      link: 'https://materia.example/today',
      settingsLink: 'https://materia.example/settings',
    });
    expect(mail.subject).toBe('Your day in Materia: 2 due today, 1 overdue, 1 unread mention');
    expect(mail.html.match(/<h2/g)).toHaveLength(2);
    expect(mail.html.match(/<ul>/g)).toHaveLength(2);
    expect(mail.html.match(/<\/ul>/g)).toHaveLength(2);
    expect(mail.html).toContain('<strong>Critical:</strong> <a href="https://materia.example/matters/m1/18">');
    expect(mail.html).toContain('Send the &lt;draft&gt;</a> · BL-2026-0042 (due 1 Oct 2026)');
    expect(mail.html).toContain('<a href="https://materia.example/inbox">1 unread mention</a>');
    expect(mail.html).toContain('href="https://materia.example/today"');
    expect(mail.text).toContain('- Call the executor: https://materia.example/matters/m1/17');
    expect(mail.text).toContain('\nOverdue\n- Send the <draft> · BL-2026-0042 (due 1 Oct 2026)');
    expect(mail.text).toContain('1 unread mention: https://materia.example/inbox');
  });

  it('leaves out empty sections', () => {
    const mail = renderMail('digest', {
      subject: 'Your day in Materia: 1 unread mention',
      dateLabel: 'Tuesday 6 October',
      dueToday: [],
      overdue: [],
      unreadMentions: 0,
      inboxLink: 'https://materia.example/inbox',
      link: 'https://materia.example/today',
      settingsLink: 'https://materia.example/settings',
    });
    expect(mail.html).not.toContain('<h2');
    expect(mail.html).not.toContain('unread');
    expect(mail.text).not.toContain('Due today');
  });

  it('refuses a non-http link inside a list item too', () => {
    expect(() =>
      renderMail('digest', { subject: 's', dueToday: [{ label: 'x', link: 'javascript:alert(1)' }], link: '' }),
    ).toThrow('http(s)');
  });
});

describe('invoice template (BILL-07)', () => {
  const model = {
    documentTitle: 'Tax invoice',
    number: 'INV-000042',
    firmName: 'Harbour & Vine Legal',
    firmAbn: '12 345 678 901',
    total: '$973.36',
    dueLabel: '20 Oct 2026',
    message: 'Dear Lan,\nPlease see attached.',
  };

  it('names the document, number and firm, and carries the message', () => {
    const mail = renderMail('invoice', model);
    expect(mail.subject).toBe('Tax invoice INV-000042 from Harbour & Vine Legal');
    expect(mail.html).toContain('Please find attached Tax invoice INV-000042 for $973.36, due 20 Oct 2026.');
    expect(mail.html).toContain('Harbour &amp; Vine Legal · ABN 12 345 678 901');
    expect(mail.text.startsWith('Dear Lan,\nPlease see attached.\n\nPlease find attached')).toBe(true);
  });

  it('leaves out an empty message and due date', () => {
    const mail = renderMail('invoice', { ...model, message: '', dueLabel: '' });
    expect(mail.text.startsWith('Please find attached Tax invoice INV-000042 for $973.36.')).toBe(true);
  });
});

describe('invoice_reminder template (BILL-08)', () => {
  const model = {
    documentTitle: 'Tax invoice',
    number: 'INV-000042',
    firmName: 'Harbour & Vine Legal',
    firmAbn: '12 345 678 901',
    total: '$973.36',
    owing: '$473.36',
    dueLabel: '20 Oct 2026',
    message: 'Dear Lan,\n\nA gentle reminder <b>.',
    attached: true,
  };

  it('carries the lawyer’s message and what is still owing, never matter content in the subject', () => {
    const mail = renderMail('invoice_reminder', model);
    expect(mail.subject).toBe('Payment reminder: Tax invoice INV-000042 from Harbour & Vine Legal');
    expect(mail.html).toContain('A gentle reminder &lt;b&gt;.');
    expect(mail.html).toContain(
      'Tax invoice INV-000042 for $973.36 was due 20 Oct 2026. $473.36 is still owing. A copy is attached.',
    );
    expect(mail.text.startsWith('Dear Lan,\n\nA gentle reminder <b>.')).toBe(true);
    expect(renderMail('invoice_reminder', { ...model, attached: false }).text).not.toContain('A copy is attached');
  });
});

describe('the feedback template (SEC-08)', () => {
  const model = {
    orgName: 'Harbour & Vine Legal',
    orgId: 'org-a',
    feedbackId: 'fb-1',
    senderName: 'Priya Fictional',
    senderEmail: 'priya@harbourvine.example',
    role: 'lawyer',
    kindLabel: 'Something isn’t working',
    body: 'The <Deadlines> page\nshows nothing.',
    page: '/deadlines',
    version: '1.2.0+abc1234',
  };

  it('names who sent it, from where, and keeps the message out of the subject', () => {
    const mail = renderMail('feedback', model);
    expect(mail.subject).toBe('Feedback from Harbour & Vine Legal: Something isn’t working');
    expect(mail.html).toContain(
      'from Priya Fictional (priya@harbourvine.example), a lawyer at Harbour &amp; Vine Legal',
    );
    expect(mail.html).toContain('The &lt;Deadlines&gt; page\nshows nothing.');
    expect(mail.text).toContain('The <Deadlines> page\nshows nothing.');
    expect(mail.text).toContain('Page: /deadlines · Version: 1.2.0+abc1234 · Practice org-a · Feedback fb-1');
  });

  it('says when the page or version is missing', () => {
    const mail = renderMail('feedback', { ...model, page: undefined, version: undefined });
    expect(mail.text).toContain('Page: not given · Version: not given');
  });
});
