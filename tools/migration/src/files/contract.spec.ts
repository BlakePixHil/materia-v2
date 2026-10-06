import {
  assertDistinctTargets,
  AvatarLineSchema,
  DocumentLineSchema,
  orphansOf,
  parseJsonl,
  TransformOutputError,
} from './contract.ts';

const DOC = 'orgs/o-1/matters/m-1/documents/d-1';
const copy = { source: 'a.pdf', target: `${DOC}/v1`, fileName: 'a.pdf', mime: 'application/pdf', sizeBytes: 3 };
const line = { path: DOC, legacyPath: 'workflows/w/cards/c/attachments/a', data: { version: 0 }, copy };

describe('the transform contract (MIG-03 → MIG-05)', () => {
  it('reads document and avatar lines, with generations as strings', () => {
    const text = `${JSON.stringify({ ...line, copy: { ...copy, generation: 1712345678901234 } })}\n\n`;
    expect(parseJsonl('documents.jsonl', text, DocumentLineSchema)).toEqual([
      { ...line, copy: { ...copy, generation: '1712345678901234' } },
    ]);
    const avatar = {
      path: 'users/u-1/avatar.png',
      legacyPath: 'profile-images/u-1.png',
      copy: { ...copy, target: 'users/u-1/avatar.png' },
    };
    expect(parseJsonl('avatars.jsonl', JSON.stringify(avatar), AvatarLineSchema)).toEqual([avatar]);
  });

  it('accepts a line whose legacy object is missing (no source)', () => {
    const { target, fileName, mime, sizeBytes } = copy;
    const missing = { target, fileName, mime, sizeBytes };
    expect(parseJsonl('d', JSON.stringify({ ...line, copy: missing }), DocumentLineSchema)).toHaveLength(1);
  });

  it('accepts bytes the transform extracted (copy.content), and refuses a malformed sha256', () => {
    const { target, fileName, mime, sizeBytes } = copy;
    const content = { encoding: 'base64', data: 'iVBORw==', sha256: 'a'.repeat(64) };
    const extracted = { ...line, copy: { target, fileName, mime, sizeBytes, md5Hash: 'bWQ1', content } };
    expect(parseJsonl('d', JSON.stringify(extracted), DocumentLineSchema)[0]?.copy.content).toEqual(content);
    const bad = { ...extracted, copy: { ...extracted.copy, content: { ...content, sha256: 'nope' } } };
    expect(() => parseJsonl('d', JSON.stringify(bad), DocumentLineSchema)).toThrow('d line 1: copy.content.sha256');
  });

  it('names the file and line of anything it cannot use', () => {
    const bad = (value: unknown) => () =>
      parseJsonl(
        'transformed/documents.jsonl',
        `${JSON.stringify(line)}\n${typeof value === 'string' ? value : JSON.stringify(value)}\n`,
        DocumentLineSchema,
      );
    expect(bad('{not json')).toThrow('transformed/documents.jsonl line 2 is not JSON.');
    expect(bad({ ...line, path: 'orgs/o-1/elsewhere' })).toThrow(/line 2: path /);
    expect(bad({ ...line, copy: { ...copy, target: 'orgs/o-1/matters/m-1/documents/d-2/v1' } })).toThrow(
      'line 2: copy.target must be the document path followed by /v1.',
    );
    expect(bad({ ...line, copy: { ...copy, sizeBytes: -1 } })).toThrow(/line 2: copy\.sizeBytes/);
    const avatar = { ...line, path: 'users/u/avatar.png', copy: { ...copy, target: 'users/u/x.png' } };
    expect(() => parseJsonl('transformed/avatars.jsonl', JSON.stringify(avatar), AvatarLineSchema)).toThrow(
      'transformed/avatars.jsonl line 1: copy.target must be the avatar path.',
    );
  });

  it('refuses two lines that copy to the same place', () => {
    expect(() => assertDistinctTargets([line, line])).toThrow(`Two lines copy to ${DOC}/v1.`);
    expect(() => assertDistinctTargets([line])).not.toThrow();
  });

  it("reads the orphans from the transform's report, or null when it doesn't say", () => {
    expect(orphansOf(null)).toBeNull();
    expect(orphansOf('{}')).toBeNull();
    expect(orphansOf(JSON.stringify({ storage: { orphans: [{ name: 'b' }, { name: 'a', size: 2 }] } }))).toEqual([
      { name: 'a', size: 2 },
      { name: 'b' },
    ]);
    expect(() => orphansOf('nope')).toThrow('report.json is not JSON.');
    expect(() => orphansOf(JSON.stringify({ storage: { orphans: 'all of them' } }))).toThrow(TransformOutputError);
  });
});
