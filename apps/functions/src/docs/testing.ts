import PizZip from 'pizzip';

import { dateOnly, type MergeSources } from '@materia/domain';

/**
 * Fixtures for the docx merge tests (INT-06). `doyleSources` is the seed's Doyle estate (Harbour &
 * Vine Legal, tools/scripts/src/seed/dataset.ts) with fixed dates and addresses, so snapshots don't
 * move with the day the tests run. Everything is fictional.
 */
export function doyleSources(overrides: Partial<MergeSources> = {}): MergeSources {
  const address = (line1: string, suburb: string) => ({
    type: 'residential' as const,
    line1,
    suburb,
    state: 'VIC',
    postcode: '3220',
    country: 'AU' as const,
  });
  return {
    org: { name: 'Harbour & Vine Legal', abn: '00000000001' },
    letterhead: {
      address: 'Level 2, 10 Example Street\nGeelong VIC 3220',
      phone: '(03) 5200 0000',
      email: 'reception@harbourvine.example',
      website: 'harbourvine.example',
      footer: 'Fictional practice for demonstration only.',
    },
    matter: {
      number: 'HV-2026-0001',
      title: 'Estate of Margaret Doyle',
      type: 'probate',
      jurisdiction: 'VIC',
      openedOn: dateOnly('2026-07-20'),
      clientContactIds: ['c-catherine-doyle'],
      deceased: {
        contactId: 'c-margaret-doyle',
        dateOfDeath: '2026-07-17',
        domicile: 'VIC',
        lastAddress: 'Geelong VIC',
      },
      fee: { arrangement: 'fixed', amountCents: 440_000, estimateLowCents: 400_000, estimateHighCents: 600_000 },
      facts: { willDate: '2019-03-14' },
    },
    contacts: {
      'c-margaret-doyle': {
        kind: 'person',
        givenNames: 'Margaret',
        familyName: 'Doyle',
        dateOfBirth: dateOnly('1944-03-02'),
        addresses: [address('10 Example Street', 'Geelong')],
      },
      'c-catherine-doyle': {
        kind: 'person',
        givenNames: 'Catherine',
        familyName: 'Doyle',
        emails: [{ type: 'personal', address: 'catherine.doyle@example.com' }],
        phones: [{ type: 'mobile', number: '+61400000001' }],
        addresses: [address('11 Example Street', 'Newtown')],
      },
      'c-peter-hale': {
        kind: 'person',
        givenNames: 'Peter',
        familyName: 'Hale',
        addresses: [address('12 Example Street', 'Belmont')],
      },
      'c-thomas-doyle': {
        kind: 'person',
        givenNames: 'Thomas',
        familyName: 'Doyle',
        addresses: [address('13 Example Street', 'Torquay')],
      },
    },
    parties: [
      { contactId: 'c-catherine-doyle', role: 'executor' },
      { contactId: 'c-peter-hale', role: 'executor' },
      { contactId: 'c-thomas-doyle', role: 'beneficiary', share: 'Whole of the residue' },
      { contactId: 'c-margaret-doyle', role: 'deceased' },
    ],
    lawyer: {
      displayName: 'Jordan Price',
      title: 'Senior Associate',
      email: 'lawyer@harbourvine.example',
      defaultRateCents: 45_000,
    },
    author: { displayName: 'Daniel Kim', title: 'Paralegal', email: 'paralegal@harbourvine.example' },
    today: dateOnly('2026-10-06'),
    ...overrides,
  };
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** A minimal .docx whose body is the given paragraphs' text (one `<w:p>` each). */
export function docxWith(paragraphs: readonly string[], extra: Record<string, string> = {}): Buffer {
  const zip = new PizZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  const body = paragraphs.map((text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`).join('');
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
  );
  for (const [name, content] of Object.entries(extra)) zip.file(name, content);
  return zip.generate({ type: 'nodebuffer' });
}

/** A part of a .docx as text (`word/document.xml` by default). */
export const docxPart = (data: Uint8Array, name = 'word/document.xml') => new PizZip(data).file(name)?.asText() ?? '';

/** The visible text of a part, one line per paragraph. */
export const docxText = (data: Uint8Array, name = 'word/document.xml') =>
  docxPart(data, name)
    .split('</w:p>')
    .map((paragraph) =>
      [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:br\/>|<w:tab\/>/g)]
        .map((m) => (m[0] === '<w:br/>' ? '\n' : m[0] === '<w:tab/>' ? '\t' : (m[1] ?? '')))
        .join('')
        .replace(/&amp;/g, '&'),
    )
    .filter((line, index, lines) => line !== '' || index < lines.length - 1)
    .join('\n');
