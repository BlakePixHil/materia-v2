import { provideRouter } from '@angular/router';
import { render, screen } from '@testing-library/angular';

import { MtMarkdown, type MtMentionMatterResolver, type MtMentionMemberResolver } from './markdown-view';

/** The notes renderer (CORE-13): mentions through resolvers, and nothing executable or remote. Fictional data only. */

const members: MtMentionMemberResolver = (uid) =>
  ({
    'user-priya': { name: 'Priya Shah' },
    'user-gone': { name: 'Morgan Fictional', former: true },
  })[uid] ?? null;

const matters: MtMentionMatterResolver = (id) =>
  ({
    'm-whitfield': {
      number: 'M-2026-0142',
      title: 'Estate of Margaret Whitfield',
      link: '/matters/m-whitfield/overview',
    },
    'm-secret': null,
  })[id];

async function show(content: string, mentions = true) {
  return render(MtMarkdown, {
    inputs: { content, mentions, member: members, matter: matters },
    providers: [provideRouter([])],
  });
}

describe('MtMarkdown', () => {
  it('renders blocks and keeps line breaks', async () => {
    const { container } = await show(
      ['## Call with Avery', 'Called **Avery**.\nShe has the *will*.', '', '- one', '- two', '', '> quote'].join('\n'),
    );
    expect(container.querySelector('b')).toHaveTextContent('Call with Avery');
    expect(container.querySelectorAll('p')[1]?.textContent).toBe('Called Avery.\nShe has the will.');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('blockquote')).toHaveTextContent('quote');
  });

  it('renders member mentions as names and matter mentions as linked chips', async () => {
    const { container } = await show(
      'Ask @[user-priya] and @[user-gone] (and @[user-nobody]) about #[m-whitfield], not #[m-secret] or #[m-loading].',
    );
    const chips = [...container.querySelectorAll('.mt-mention')].map((chip) => [
      chip.getAttribute('data-kind'),
      chip.textContent?.replace(/\s+/g, ' ').trim(),
    ]);
    expect(chips).toEqual([
      ['member', '@Priya Shah'],
      ['matter', 'M-2026-0142 Estate of Margaret Whitfield'],
      ['restricted', 'Restricted matter'],
      ['pending', 'Matter…'],
    ]);
    // A former or unknown member is plain text, not a chip.
    expect(container.textContent).toContain('and Morgan Fictional (and Unknown member)');
    const link = screen.getByRole('link', { name: 'M-2026-0142 Estate of Margaret Whitfield' });
    expect(link).toHaveAttribute('href', '/matters/m-whitfield/overview');
    // The restricted matter isn't linked and doesn't leak its id.
    expect(container.textContent).not.toContain('m-secret');
  });

  it('shows tokens and citation markers as text without `mentions`', async () => {
    const { container } = await show('Ask @[user-priya] [1]', false);
    expect(container.querySelector('.mt-mention')).toBeNull();
    expect(container.querySelector('sup')).toBeNull();
    expect(container.textContent?.trim()).toBe('Ask @[user-priya] [1]');
  });
});

/**
 * XSS fixtures: every one must render without anything executable or remote. Links are only ever
 * http(s) or mailto; there are no images, frames, scripts, styles or event-handler attributes.
 */
const XSS = [
  '[click](javascript:alert(1))',
  '[click](JaVaScRiPt:alert(1))',
  '[click]( javascript:alert(1))',
  '[click](java\tscript:alert(1))',
  '[click](java&#115;cript:alert(1))',
  '[click](&#106;avascript:alert(1))',
  '[click](&#x6A;avascript&#x3A;alert(1))',
  '[click](%6Aavascript:alert(1))',
  '[click](\\u006Aavascript:alert(1))',
  '[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '[click](DATA:text/html,<script>alert(1)</script>)',
  '[click](vbscript:msgbox(1))',
  '[click](VBScript:msgbox(1))',
  '[click](file:///etc/passwd)',
  '[click](//evil.example/x)',
  '[click](https://ok.example" onclick="alert(1))',
  '[click](https://ok.example/"onmouseover="alert(1))',
  '<script>alert(1)</script>',
  '<SCRIPT SRC=https://evil.example/x.js></SCRIPT>',
  '<img src=x onerror=alert(1)>',
  '<img src="https://evil.example/pixel.gif">',
  '![pixel](https://evil.example/pixel.gif)',
  '![x](javascript:alert(1))',
  '<iframe src="https://evil.example"></iframe>',
  '<a href="javascript:alert(1)">click</a>',
  '<div style="background:url(javascript:alert(1))">x</div>',
  '<svg onload=alert(1)>',
  '<p onclick="alert(1)">hi</p>',
  '<style>body{display:none}</style>',
  '<link rel="stylesheet" href="https://evil.example/x.css">',
  '<object data="https://evil.example/x.swf"></object>',
  '<https://evil.example>',
  '<javascript:alert(1)>',
  'https://bare.example/autolink and www.evil.example',
  '**<img src=x onerror=alert(1)>**',
  '@[<img src=x onerror=alert(1)>] #[javascript:alert(1)]',
  '`<script>alert(1)</script>`',
  '```\n<script>alert(1)</script>\n```',
];

describe('MtMarkdown XSS fixtures', () => {
  it.each(XSS)('renders %j inertly', async (content) => {
    const { container } = await show(content);
    expect(
      container.querySelector('script, img, iframe, object, embed, style, link, form, input, video, audio, source'),
    ).toBeNull();
    // The only SVG is a design-system icon (mt-icon), never one from the text.
    for (const svg of container.querySelectorAll('svg')) expect(svg.closest('mt-icon')).not.toBeNull();
    for (const element of container.querySelectorAll('*')) {
      for (const attribute of element.attributes) {
        expect(attribute.name.startsWith('on'), `${element.tagName} ${attribute.name}`).toBe(false);
        expect(attribute.name).not.toBe('style');
        expect(attribute.name).not.toBe('srcdoc');
        expect(attribute.name).not.toBe('src');
      }
    }
    for (const link of container.querySelectorAll('a')) {
      const href = link.getAttribute('href') ?? '';
      // Matter chips are router links to an internal path; anything else must be http(s) or mailto.
      if (link.classList.contains('mt-mention')) expect(href).toMatch(/^\/matters\//);
      else expect(href).toMatch(/^(https?:\/\/|mailto:)/i);
      expect(href).not.toMatch(/javascript|vbscript|data:/i);
    }
  });

  it('keeps raw HTML as visible text', async () => {
    const { container } = await show('<img src=x onerror=alert(1)> and <script>alert(1)</script>');
    expect(container.textContent).toContain('<img src=x onerror=alert(1)> and <script>alert(1)</script>');
  });

  it('keeps an image’s alt text only', async () => {
    const { container } = await show('See ![the pixel](https://evil.example/pixel.gif).');
    expect(container.textContent?.trim()).toBe('See the pixel.');
  });

  it('links only safe URLs, opening in a new tab without an opener', async () => {
    await show('[the Act](https://legislation.vic.gov.au) and [mail](mailto:executor@example.test)');
    const act = screen.getByRole('link', { name: 'the Act' });
    expect(act).toHaveAttribute('href', 'https://legislation.vic.gov.au');
    expect(act).toHaveAttribute('rel', 'noopener noreferrer');
    expect(act).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('link', { name: 'mail' })).toHaveAttribute('href', 'mailto:executor@example.test');
  });
});
