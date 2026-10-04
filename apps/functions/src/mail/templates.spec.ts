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
