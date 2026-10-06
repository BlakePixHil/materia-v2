import { buildMergeData, SYSTEM_DOC_TEMPLATES, templateInputs } from '@materia/domain';

import { inspectTemplate, mergeTemplate, TemplateMergeError } from './engine';
import { systemTemplateDocx } from './system-templates';
import { docxPart, docxText, docxWith, doyleSources } from './testing';

const merge = (data: Buffer, extra: Record<string, unknown> = {}) =>
  mergeTemplate(data, { ...buildMergeData(doyleSources()), ...extra });

describe('system templates on the seeded Doyle estate', () => {
  it.each(SYSTEM_DOC_TEMPLATES.map((t) => t.id))('%s checks out and merges (snapshot of the XML)', (id) => {
    const { data } = systemTemplateDocx(id);
    const inspected = inspectTemplate(data);
    expect(inspected.problems).toEqual([]);
    expect(inspected.warnings).toEqual([]);
    // What "New from template" asks for matches the template's own tags.
    expect(templateInputs(inspected.fields)).toEqual(SYSTEM_DOC_TEMPLATES.find((t) => t.id === id)?.inputs);
    const { output, missing } = merge(data);
    expect(missing).toEqual([]);
    expect(docxPart(output)).toMatchSnapshot('document.xml');
    expect(docxPart(output, 'word/header1.xml')).toMatchSnapshot('header1.xml');
    expect(docxPart(output, 'word/footer1.xml')).toMatchSnapshot('footer1.xml');
  });

  it('fills the letter to the client', () => {
    const text = docxText(merge(systemTemplateDocx('system-letter').data).output);
    expect(text).toContain('6 October 2026');
    expect(text).toContain('Catherine Doyle\n11 Example Street\nNewtown VIC 3220');
    expect(text).toContain('Our reference: HV-2026-0001');
    expect(text).toContain('Dear Catherine');
    expect(text).toContain('Please contact me on (03) 5200 0000 or at lawyer@harbourvine.example');
    expect(text).toContain('Jordan Price\nSenior Associate\nHarbour & Vine Legal');
  });

  it('puts the letterhead in the header and the footer note in the footer', () => {
    const { output } = merge(systemTemplateDocx('system-letterhead').data);
    expect(docxText(output, 'word/header1.xml')).toBe(
      [
        'Harbour & Vine Legal',
        'Level 2, 10 Example Street, Geelong VIC 3220',
        'Phone (03) 5200 0000   Email reception@harbourvine.example   harbourvine.example',
        'ABN 00 000 000 001',
      ].join('\n'),
    );
    expect(docxText(output, 'word/footer1.xml')).toContain('Fictional practice for demonstration only.');
  });

  it('takes a Markdown body and a recipient on the letterhead', () => {
    const { output, missing } = merge(systemTemplateDocx('system-letterhead').data, {
      body: 'We confirm that **probate** was granted.\n\n- Item one\n- Item two',
      recipient: { name: 'Thomas Doyle', address: '13 Example Street\nTorquay VIC 3228' },
    });
    expect(missing).toEqual([]);
    const text = docxText(output);
    expect(text).toContain('Thomas Doyle\n13 Example Street\nTorquay VIC 3228');
    expect(text).toContain('We confirm that probate was granted.');
    expect(text).toContain('•\tItem one');
    expect(docxPart(output)).toContain('<w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">probate</w:t>');
  });

  it('leaves out the recipient block and keeps a paragraph to type into without data', () => {
    const { output } = merge(systemTemplateDocx('system-letterhead').data);
    const text = docxText(output);
    expect(text).not.toContain('{');
    expect(text).toContain('Our reference: HV-2026-0001');
  });

  it('shows the fee terms the matter has and the estimate range', () => {
    const text = docxText(merge(systemTemplateDocx('system-costs-disclosure').data).output);
    expect(text).toContain('Fee arrangement: Fixed fee');
    expect(text).toContain('Fixed fee: $4,400.00');
    expect(text).not.toContain('Fee cap');
    expect(text).toContain('Our current estimate is $4,000.00 to $6,000.00.');
    expect(text).not.toContain('Hourly rate');
  });

  it('falls back to a single estimate, then the fixed fee, then shows the estimate as missing', () => {
    const disclosure = systemTemplateDocx('system-costs-disclosure').data;
    const withFee = (fee: Record<string, unknown>) => {
      const base = doyleSources();
      return mergeTemplate(disclosure, buildMergeData({ ...base, matter: { ...base.matter, fee } }));
    };
    const single = withFee({ arrangement: 'hourly', hourlyRateCents: 45_000, estimateCents: 700_000 });
    expect(docxText(single.output)).toContain('Our current estimate is $7,000.00.');
    const fixed = withFee({ arrangement: 'fixed', amountCents: 440_000 });
    expect(fixed.missing).toEqual([]);
    expect(docxText(fixed.output)).toContain(
      'Our estimate of your total legal costs is the fixed fee of $4,400.00, plus any disbursements.',
    );
    const none = withFee({ arrangement: 'hourly', hourlyRateCents: 45_000 });
    expect(none.missing).toEqual(['fee.estimate']);
    expect(docxText(none.output)).toContain('Our current estimate is [[missing: fee.estimate]].');
  });
});

describe('missing fields', () => {
  it('prints a marker and lists each missing field once, in order', () => {
    const sources = doyleSources({ letterhead: {} });
    const data = { ...buildMergeData(sources), client: { fullName: 'Catherine Doyle' } };
    const { output, missing } = mergeTemplate(systemTemplateDocx('system-letter').data, data);
    // The header is merged first; an empty email or website only drops its condition.
    expect(missing).toEqual(['firm.addressLine', 'client.address', 'client.firstName', 'firm.phone']);
    expect(docxText(output)).toContain('[[missing: client.address]]');
    expect(docxText(output, 'word/header1.xml')).toContain('[[missing: firm.addressLine]]');
  });

  it('names a list item’s missing field by the list', () => {
    const template = docxWith(['{#beneficiaries}{fullName}: {email}{/beneficiaries}']);
    const { output, missing } = merge(template);
    expect(missing).toEqual(['beneficiaries.email']);
    expect(docxText(output)).toBe('Thomas Doyle: [[missing: beneficiaries.email]]');
  });

  it('leaves optional fields blank', () => {
    const { output, missing } = merge(docxWith(['Ref {matter.reference}.']));
    expect(missing).toEqual([]);
    expect(docxText(output)).toBe('Ref .');
  });
});

describe('tags and formatters', () => {
  it('formats dates, money and case', () => {
    const template = docxWith([
      '{deceased.dateOfDeath|date} / {deceased.dateOfDeath} / {deceased.dateOfDeath|upper}',
      '{fee.amount|money} / {client.fullName|upper} / {client.fullName|lower}',
      '{#executors}{fullName}; {/executors}',
      '{executorNames}',
    ]);
    expect(docxText(merge(template).output)).toBe(
      [
        '17 July 2026 / 17 July 2026 / 17 JULY 2026',
        '$4,400.00 / CATHERINE DOYLE / catherine doyle',
        'Catherine Doyle; Peter Hale; ',
        'Catherine Doyle and Peter Hale',
      ].join('\n'),
    );
  });

  it('runs a large loop quickly (200 beneficiaries)', () => {
    const base = doyleSources();
    const contacts = { ...base.contacts };
    const parties = [...base.parties];
    for (let i = 0; i < 200; i++) {
      contacts[`c-b-${i}`] = { kind: 'person', givenNames: `Person${i}`, familyName: 'Example' };
      parties.push({ contactId: `c-b-${i}`, role: 'beneficiary' });
    }
    const template = docxWith(['{#beneficiaries}', '{fullName} {share}', '{/beneficiaries}']);
    const started = performance.now();
    const { output } = mergeTemplate(template, buildMergeData({ ...base, contacts, parties }));
    expect(performance.now() - started).toBeLessThan(2000);
    const lines = docxText(output).split('\n');
    expect(lines).toHaveLength(201);
    expect(lines[200]).toBe('Person199 Example ');
  });
});

describe('inspectTemplate', () => {
  it('names malformed tags', () => {
    const { problems } = inspectTemplate(docxWith(['Dear {client.firstName', '{/executors}', '{#beneficiaries} open']));
    expect(problems.map((p) => p.message)).toEqual([
      'The tag {client.firstName has no closing brace.',
      '{/executors} closes a section that was never opened. Add {#executors} where it should start.',
      '{#beneficiaries} is never closed. Add {/beneficiaries} where it should end.',
    ]);
    expect(problems.every((p) => p.code === 'syntax')).toBe(true);
  });

  it('names unknown fields and formatters, with the right spelling when only the case differs', () => {
    const { problems, fields } = inspectTemplate(
      docxWith(['{client.fullname}', '{matter.colour}', '{today|shout}', '{#executors}{fullname}{/executors}']),
    );
    expect(problems.map((p) => p.message)).toEqual([
      '{client.fullname} isn’t a field. Did you mean {client.fullName}?',
      '{matter.colour} isn’t a field. See Template fields for the ones you can use.',
      '{today|shout} uses “shout”, which isn’t a formatter. Use date, money, upper, lower.',
      '{fullname} isn’t a field. Did you mean {fullName}?',
    ]);
    expect(fields).toContain('client.fullname');
  });

  it('lists the fields a template uses, full paths, once each', () => {
    const { fields, problems } = inspectTemplate(
      docxWith(['{client.fullName} {client.fullName}', '{#executors}{fullName} {firm.name}{/executors}', '{@body}']),
    );
    expect(problems).toEqual([]);
    expect(fields).toEqual(['body', 'client.fullName', 'executors', 'executors.fullName', 'firm.name']);
  });

  it('refuses a file that isn’t a Word document', () => {
    expect(inspectTemplate(Buffer.from('not a zip')).problems).toEqual([
      { tag: 'the file', code: 'syntax', message: 'This isn’t a Word document (.docx).' },
    ]);
    expect(() => mergeTemplate(Buffer.from('nope'), {})).toThrow(TemplateMergeError);
  });

  it('warns about fonts the PDF preview substitutes', () => {
    const styles =
      '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>';
    const theme =
      '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>';
    const template = docxWith(['{client.fullName}'], { 'word/styles.xml': styles, 'word/theme/theme1.xml': theme });
    expect(inspectTemplate(template).warnings).toEqual([
      'The PDF preview uses a similar font in place of Aptos. The Word document keeps the original.',
    ]);
  });
});
