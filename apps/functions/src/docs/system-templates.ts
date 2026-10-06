import PizZip from 'pizzip';

import { DomainError, systemDocTemplate, type SystemDocTemplate } from '@materia/domain';

/**
 * The system default letterhead and sample templates (INT-06), built here as .docx files rather
 * than kept as binaries, so a change is reviewable and the snapshot tests cover the XML. They share
 * one letterhead: the firm's name, address, phone, email and ABN in the header, and its footer note
 * and page number in the footer. A4, Calibri 11 pt (the preview renders it with Carlito, which has
 * the same metrics). Firms download one, change it in Word and upload their own.
 */

const W =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface RunSpec {
  text: string;
  bold?: boolean;
  italic?: boolean;
  highlight?: boolean;
}

type Inline = string | RunSpec;

interface ParagraphSpec {
  style?: string;
  align?: 'right' | 'center';
  keepNext?: boolean;
  runs: readonly Inline[];
}

const run = (inline: Inline) => {
  const spec = typeof inline === 'string' ? { text: inline } : inline;
  const props = [
    spec.bold ? '<w:b/>' : '',
    spec.italic ? '<w:i/>' : '',
    spec.highlight ? '<w:highlight w:val="yellow"/>' : '',
  ]
    .filter(Boolean)
    .join('');
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${escapeXml(spec.text)}</w:t></w:r>`;
};

const p = (spec: ParagraphSpec | string) => {
  const s: ParagraphSpec = typeof spec === 'string' ? { runs: [spec] } : spec;
  const props = [
    s.style ? `<w:pStyle w:val="${s.style}"/>` : '',
    s.keepNext ? '<w:keepNext/>' : '',
    s.align ? `<w:jc w:val="${s.align}"/>` : '',
  ].join('');
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${s.runs
    .filter((r) => r !== '')
    .map(run)
    .join('')}</w:p>`;
};

const blank = () => p({ runs: [] });
const label = (name: string, value: string) => p({ runs: [{ text: `${name}: `, bold: true }, value] });
/** Paragraphs shown only when the field has a value (the section's own paragraphs are dropped). */
const when = (field: string, ...paragraphs: string[]) => [p(`{#${field}}`), ...paragraphs, p(`{/${field}}`)];

/** A4 with 2 cm side margins, header and footer referenced as rId10/rId11. */
const SECTION =
  '<w:sectPr><w:headerReference w:type="default" r:id="rId10"/><w:footerReference w:type="default" r:id="rId11"/>' +
  '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1701" w:right="1134" w:bottom="1418" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>';

const document = (paragraphs: readonly string[]) =>
  `${XML}<w:document ${W}><w:body>${paragraphs.join('')}${SECTION}</w:body></w:document>`;

const HEADER = `${XML}<w:hdr ${W}>${[
  p({ style: 'FirmName', runs: ['{firm.name}'] }),
  p({ style: 'Letterhead', runs: ['{firm.addressLine}'] }),
  p({
    style: 'Letterhead',
    runs: [
      '{#firm.phone}Phone {firm.phone}{/firm.phone}{#firm.email}   Email {firm.email}{/firm.email}{#firm.website}   {firm.website}{/firm.website}',
    ],
  }),
  p({ style: 'LetterheadRule', runs: ['{#firm.abn}ABN {firm.abn}{/firm.abn}'] }),
].join('')}</w:hdr>`;

const FOOTER = `${XML}<w:ftr ${W}>${p({ style: 'Footer', runs: ['{firm.footer}'] })}<w:p><w:pPr><w:pStyle w:val="Footer"/><w:jc w:val="right"/></w:pPr><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>`;

const style = (id: string, name: string, body: string, extra = '') =>
  `<w:style w:type="paragraph" w:styleId="${id}"${extra}><w:name w:val="${name}"/>${body}</w:style>`;

const STYLES = `${XML}<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-AU"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>${[
  style('Normal', 'Normal', '<w:qFormat/>', ' w:default="1"'),
  style(
    'Title',
    'Title',
    '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr>',
  ),
  style(
    'Heading1',
    'heading 1',
    '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr>',
  ),
  style(
    'Heading2',
    'heading 2',
    '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr>',
  ),
  style(
    'Heading3',
    'heading 3',
    '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="60"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:i/></w:rPr>',
  ),
  style('NoSpacing', 'No Spacing', '<w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="0"/></w:pPr>'),
  style(
    'FirmName',
    'Firm name',
    '<w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="40"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr>',
  ),
  style(
    'Letterhead',
    'Letterhead',
    '<w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:color w:val="555555"/><w:sz w:val="18"/></w:rPr>',
  ),
  style(
    'LetterheadRule',
    'Letterhead rule',
    '<w:basedOn w:val="Letterhead"/><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="6" w:color="999999"/></w:pBdr><w:spacing w:after="240"/></w:pPr>',
  ),
  style(
    'Footer',
    'footer',
    '<w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:color w:val="555555"/><w:sz w:val="16"/></w:rPr>',
  ),
].join('')}</w:styles>`;

const CONTENT_TYPES = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;

const ROOT_RELS = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;

const DOCUMENT_RELS = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/><Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rId11" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`;

const SETTINGS = `${XML}<w:settings ${W}><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;

const core = (title: string) =>
  `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(title)}</dc:title><dc:creator>Materia</dc:creator></cp:coreProperties>`;

const APP = `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Materia</Application></Properties>`;

/** The signature block every letter ends with. */
const tight = (text: string, keepNext = true) => p({ style: 'NoSpacing', keepNext, runs: [text] });

/** The responsible lawyer's name, title and firm, kept together. */
const signatureBlock = () => [tight('{lawyer.fullName}'), tight('{lawyer.title}'), tight('{firm.name}', false)];

/** The signature block every letter ends with. */
const signature = (closing: string) => [p({ keepNext: true, runs: [closing] }), blank(), blank(), ...signatureBlock()];

/** The costs disclosures' warning that they are placeholders, not reviewed wording. */
const PLACEHOLDER_NOTE = [
  p({
    runs: [
      {
        text: 'Illustrative placeholder only. Replace this template with your firm’s own costs disclosure, reviewed by a practitioner, before it is given to a client.',
        italic: true,
        highlight: true,
      },
    ],
  }),
];

/** On an updated disclosure (BILL-06): what it updates. Dropped entirely on a first disclosure. */
const UPDATED_NOTE = when(
  'disclosure.updated',
  p({ runs: [{ text: 'Updated costs disclosure', bold: true }] }),
  p(
    'This updates the costs disclosure we gave you earlier.{#disclosure.previousEstimate} We previously estimated your total legal costs at {disclosure.previousEstimate}.{/disclosure.previousEstimate}',
  ),
);

// A range, else a single estimate, else the fixed fee; with none of them the estimate shows as missing.
const ESTIMATE = p(
  '{#fee.estimateHigh}Our current estimate is {fee.estimateLow} to {fee.estimateHigh}.{/fee.estimateHigh}' +
    '{^fee.estimateHigh}{#fee.estimate}Our current estimate is {fee.estimate}.{/fee.estimate}' +
    '{^fee.estimate}{#fee.amount}Our estimate of your total legal costs is the fixed fee of {fee.amount}, plus any disbursements.{/fee.amount}' +
    '{^fee.amount}Our current estimate is {fee.estimate}.{/fee.amount}{/fee.estimate}{/fee.estimateHigh}',
);

const BODIES: Record<string, () => string[]> = {
  'system-letterhead': () => [
    p('{today}'),
    blank(),
    p('{#recipient}'),
    tight('{name}'),
    tight('{address}'),
    blank(),
    p('{/recipient}'),
    p({ runs: [{ text: 'Our reference: ', bold: true }, '{matter.number}'] }),
    blank(),
    p({ runs: [{ text: '{matter.title}', bold: true }] }),
    p('{@body}'),
    ...signature('Yours sincerely'),
  ],
  'system-letter': () => [
    p('{today}'),
    blank(),
    tight('{client.fullName}'),
    tight('{client.address}'),
    blank(),
    p({ runs: [{ text: 'Our reference: ', bold: true }, '{matter.number}'] }),
    blank(),
    p('Dear {client.firstName}'),
    p({ runs: [{ text: '{matter.title}', bold: true }] }),
    p('Thank you for your instructions in this matter.'),
    p('{@body}'),
    p('Please contact me on {firm.phone} or at {lawyer.email} if you have any questions.'),
    ...signature('Yours sincerely'),
  ],
  'system-file-note': () => [
    p({ style: 'Title', runs: ['File note'] }),
    label('Matter', '{matter.number}  {matter.title}'),
    label('Client', '{clientNames}'),
    label('Date', '{today}'),
    label('Author', '{author.fullName}{#author.title}, {author.title}{/author.title}'),
    label('Attendance', ''),
    p({ style: 'Heading1', runs: ['Notes'] }),
    p('{@body}'),
  ],
  'system-costs-disclosure': () => [
    p({ style: 'Title', runs: ['Costs disclosure'] }),
    ...PLACEHOLDER_NOTE,
    ...UPDATED_NOTE,
    label('Client', '{client.fullName}'),
    label('Matter', '{matter.number}  {matter.title}'),
    label('Date', '{today}'),
    p({ style: 'Heading1', runs: ['How we will charge'] }),
    label('Fee arrangement', '{fee.arrangement}'),
    ...when('fee.amount', label('Fixed fee', '{fee.amount}')),
    ...when('fee.cap', label('Fee cap', '{fee.cap}')),
    ...when('fee.hourlyRate', label('Hourly rate', '{fee.hourlyRate}')),
    p({ style: 'Heading1', runs: ['Estimate of total legal costs'] }),
    ESTIMATE,
    p('We will tell you in writing if this estimate changes significantly.'),
    p({ style: 'Heading1', runs: ['Your rights'] }),
    p({ runs: [{ text: '[Your firm’s statement of the client’s rights goes here.]', highlight: true }] }),
    blank(),
    ...signatureBlock(),
  ],
  // BILL-06: matters whose estimate allows the uniform standard disclosure form.
  'system-costs-disclosure-short': () => [
    p({ style: 'Title', runs: ['Costs disclosure (short form)'] }),
    ...PLACEHOLDER_NOTE,
    ...UPDATED_NOTE,
    label('Client', '{client.fullName}'),
    label('Matter', '{matter.number}  {matter.title}'),
    label('Date', '{today}'),
    p(
      'Your total legal costs are not likely to be more than the amount the Uniform General Rules set for this form, so we can give you this short form instead of a full costs disclosure.',
    ),
    p({ style: 'Heading1', runs: ['Our estimate'] }),
    ESTIMATE,
    label('Fee arrangement', '{fee.arrangement}'),
    ...when('fee.hourlyRate', label('Hourly rate', '{fee.hourlyRate}')),
    p('Disbursements (such as court fees and searches) and GST are charged as well.'),
    p({ style: 'Heading1', runs: ['Your rights'] }),
    p({
      runs: [{ text: '[The uniform standard disclosure form’s statement of your rights goes here.]', highlight: true }],
    }),
    blank(),
    ...signatureBlock(),
  ],
};

const cache = new Map<string, Buffer>();

/** A system template's .docx (built once per instance). NOT_FOUND for an unknown id. */
export function systemTemplateDocx(id: string): { template: SystemDocTemplate; data: Buffer } {
  const template = systemDocTemplate(id);
  const body = BODIES[id];
  if (!template || !body) throw new DomainError('NOT_FOUND', 'Template not found', { templateId: id });
  let data = cache.get(id);
  if (!data) {
    const zip = new PizZip();
    zip.file('[Content_Types].xml', CONTENT_TYPES);
    zip.file('_rels/.rels', ROOT_RELS);
    zip.file('docProps/core.xml', core(template.name));
    zip.file('docProps/app.xml', APP);
    zip.file('word/document.xml', document(body()));
    zip.file('word/styles.xml', STYLES);
    zip.file('word/settings.xml', SETTINGS);
    zip.file('word/header1.xml', HEADER);
    zip.file('word/footer1.xml', FOOTER);
    zip.file('word/_rels/document.xml.rels', DOCUMENT_RELS);
    data = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
    cache.set(id, data);
  }
  return { template, data };
}
