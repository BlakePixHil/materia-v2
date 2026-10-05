import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { applyBlock, entityWhitelists, main, renderBlock, RULES_FILE, STORAGE_RULES_FILE } from './rules-sync.ts';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

const fakeDomain = {
  PERMISSIONS: { 'task.edit': ['owner', 'lawyer'], 'org.delete': ['owner'] },
  Task: { path: 'orgs/{orgId}/matters/{matterId}/tasks', schema: {}, update: { shape: { title: 1, status: 1 } } },
  Audit: { path: 'orgs/{orgId}/audit', schema: {}, update: { shape: {} } },
  NotAnEntity: { path: 'x' },
};

describe('rules-sync', () => {
  it('lists each entity with its update-schema keys', () => {
    expect(entityWhitelists(fakeDomain)).toEqual([
      ['Audit', []],
      ['Task', ['title', 'status']],
    ]);
  });

  it('renders perm() from PERMISSIONS and fields<Entity>() from the whitelists', () => {
    const block = renderBlock(fakeDomain);
    expect(block).toContain("'task.edit': ['owner', 'lawyer']");
    expect(block).toContain("function fieldsTask() { return ['title', 'status']; }");
    expect(block).toContain('function fieldsAudit() { return []; }');
    expect(renderBlock(fakeDomain, { fields: false })).not.toContain('fieldsTask');
  });

  it('renders uploadTypes() from UPLOAD_TYPES for the Storage rules only (CORE-12)', () => {
    const withUploads = {
      ...fakeDomain,
      UPLOAD_TYPES: { pdf: { mime: 'application/pdf' }, txt: { mime: 'text/plain' } },
    };
    const block = renderBlock(withUploads, { fields: false, uploads: true });
    expect(block).toContain("'pdf': 'application/pdf',\n        'txt': 'text/plain'");
    expect(block).toContain('function uploadTypes()');
    expect(renderBlock(withUploads)).not.toContain('uploadTypes');
  });

  it('replaces only the marked block, and fails without markers', () => {
    const rules = 'before\n    // <generated:rules-sync>\n    old\n    // </generated:rules-sync>\nafter\n';
    const next = applyBlock(rules, '    // <generated:rules-sync>\n    new\n    // </generated:rules-sync>');
    expect(next).toBe('before\n    // <generated:rules-sync>\n    new\n    // </generated:rules-sync>\nafter\n');
    expect(() => applyBlock('no markers', 'x')).toThrow(/markers/);
  });

  it('the repository rules are in sync with libs/domain', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await expect(main(['--check'], repoRoot)).resolves.toBeUndefined();
    } finally {
      log.mockRestore();
    }
  });

  it('--check fails on drift; a normal run repairs it', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'rules-sync-'));
    cpSync(path.join(repoRoot, 'firebase'), path.join(root, 'firebase'), {
      recursive: true,
      filter: (src) => !src.includes('node_modules'),
    });
    const file = path.join(root, RULES_FILE);
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        "function fieldsTask() { return ['title',",
        "function fieldsTask() { return ['hacked', 'title',",
      ),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await expect(main(['--check'], root)).rejects.toThrow(/Out of sync with libs\/domain: firebase\/firestore.rules/);
      await main([], root);
      await expect(main(['--check'], root)).resolves.toBeUndefined();
      expect(readFileSync(path.join(root, STORAGE_RULES_FILE), 'utf8')).toContain('function perm(action)');
      await main(['--print'], root);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('function fieldsTask()'));
    } finally {
      log.mockRestore();
    }
  });
});
