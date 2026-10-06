import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { byCodeUnit } from '../export/jsonl.ts';
import { AvatarLineSchema, DocumentLineSchema } from '../files/contract.ts';
import { documentRecord, type FileResult } from '../files/copy.ts';

/**
 * MIG-03's golden output (`tools/migration/fixtures/golden/`): what the transform writes for the
 * legacy fixtures, byte for byte, as the load reads it once MIG-05 has copied the files. The copy
 * is stood in for: each attachment the transform found gets made-up bytes (the fixtures list no
 * checksums for them), an image from a description its own, and each document the copy's real
 * record (`documentRecord`); the one legacy lost stays missing. Fictional data only.
 */

export const GOLDEN_DIR = join(import.meta.dirname, '../../fixtures/golden');
export const GOLDEN_RUN = 'fixture-run';
export const GOLDEN_UID = 'AlexRiversLegacyUid000000001';
export const GOLDEN_ORG = 'nV2gQ3j4JvboeXNIX68x';
const SCANNED_AT = '2026-10-06T21:30:00.000Z';

/** A file the copy would have left in the files bucket, with its metadata. */
export interface GoldenObject {
  name: string;
  bytes: Buffer;
  contentType: string;
  metadata: Record<string, string>;
}

function jsonl(lines: readonly unknown[]): string {
  return lines.map((line) => `${JSON.stringify(line)}\n`).join('');
}

function copied(legacyPath: string, bytes: Buffer): { result: FileResult; metadata: Record<string, string> } {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    result: { outcome: 'copied', sha256, sizeBytes: bytes.length, scannedAt: SCANNED_AT },
    metadata: { migrationRunId: GOLDEN_RUN, legacyPath, sha256, scan: 'clean', scannedAt: SCANNED_AT },
  };
}

/** The run's files (the transform's, then the copy's `files/*.jsonl`) and the copied objects. */
export function goldenRun(): { files: Map<string, string>; objects: GoldenObject[] } {
  const files = new Map<string, string>();
  for (const name of ['report.json', 'idmap.jsonl']) files.set(name, readFileSync(join(GOLDEN_DIR, name), 'utf8'));
  for (const name of readdirSync(join(GOLDEN_DIR, 'transformed')).sort()) {
    files.set(`transformed/${name}`, readFileSync(join(GOLDEN_DIR, 'transformed', name), 'utf8'));
  }
  const parse = (name: string) =>
    (files.get(name) ?? '')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);

  const objects: GoldenObject[] = [];
  const documents = parse('transformed/documents.jsonl').map((raw) => {
    const line = DocumentLineSchema.parse(raw);
    if (!line.copy.source && !line.copy.content) {
      return { ...line, data: documentRecord(line, { outcome: 'missing' }), result: { outcome: 'missing' } };
    }
    // An image from a description carries its bytes; a legacy attachment's are made up.
    const bytes = line.copy.content
      ? Buffer.from(line.copy.content.data, 'base64')
      : Buffer.from(`%PDF-1.4\n% A made-up copy of ${line.legacyPath}\n%%EOF\n`);
    const { result, metadata } = copied(line.legacyPath, bytes);
    objects.push({ name: line.copy.target, bytes, contentType: line.copy.mime, metadata });
    return { ...line, data: documentRecord(line, result), result };
  });
  files.set('files/documents.jsonl', jsonl(documents.sort((a, b) => byCodeUnit(a.path, b.path))));

  const avatars = parse('transformed/avatars.jsonl').map((raw) => {
    const line = AvatarLineSchema.parse(raw);
    const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);
    const { result, metadata } = copied(line.legacyPath, bytes);
    objects.push({ name: line.copy.target, bytes, contentType: 'image/png', metadata });
    return { ...line, result };
  });
  files.set('files/avatars.jsonl', jsonl(avatars));
  return { files, objects };
}
