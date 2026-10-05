/**
 * `materia-scripts decode-stack --maps <dir> [--file stack.txt]`
 * Deobfuscates a minified web stack trace (FND-21) with the release's private sourcemaps. Copy the
 * stack from Error Reporting, download the maps for its release, then decode:
 *
 *   gcloud storage cp -r "gs://materia-v2-dev-sourcemaps/web/<sha>/*" /tmp/maps/
 *   pnpm materia-scripts decode-stack --maps /tmp/maps --file stack.txt   # or pipe it on stdin
 *
 * The release SHA is in the error's version (`<version>+<sha>`). See docs/runbooks/incident-response.md.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { SourceMapConsumer, type RawSourceMap } from 'source-map-js';

// `at fn (https://host/chunk-ABC.js:1:2345)`, `at https://host/chunk-ABC.js:1:2345` or `fn@https://host/chunk-ABC.js:1:2345`.
const FRAME = /^(\s*(?:at\s+)?)(?:(.*?)\s*\(|(.*?)@)?([^\s()@]*\/)?([^/\s()@:]+\.js):(\d+):(\d+)\)?\s*$/;

export type MapLoader = (file: string) => RawSourceMap | null;

/** Loads `<file>.map` from a directory of downloaded sourcemaps. */
export function dirLoader(dir: string): MapLoader {
  const cache = new Map<string, RawSourceMap | null>();
  return (file) => {
    if (!cache.has(file)) {
      const mapPath = path.join(dir, `${file}.map`);
      cache.set(file, existsSync(mapPath) ? (JSON.parse(readFileSync(mapPath, 'utf8')) as RawSourceMap) : null);
    }
    return cache.get(file) ?? null;
  };
}

/** Rewrites each frame to its original source, line, column and name; other lines are kept. */
export function decodeStack(stack: string, load: MapLoader): string {
  const consumers = new Map<string, SourceMapConsumer | null>();
  return stack
    .split('\n')
    .map((line) => {
      const match = FRAME.exec(line);
      if (!match) return line;
      const [, prefix = '', fnParen, fnAt, , file = '', lineNo = '0', column = '0'] = match;
      if (!consumers.has(file)) {
        const raw = load(file);
        consumers.set(file, raw ? new SourceMapConsumer(raw) : null);
      }
      const consumer = consumers.get(file);
      if (!consumer) return `${line}   [no sourcemap for ${file}]`;
      const pos = consumer.originalPositionFor({ line: Number(lineNo), column: Number(column) - 1 });
      if (!pos.source) return `${line}   [not mapped]`;
      const name = pos.name ?? fnParen ?? fnAt ?? '<anonymous>';
      const indent = prefix.replace(/at\s+$/, '');
      return `${indent}at ${name} (${pos.source}:${pos.line}:${(pos.column ?? 0) + 1})`;
    })
    .join('\n');
}

export async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { maps: { type: 'string' }, file: { type: 'string' } } });
  if (!values.maps) throw new Error('Usage: materia-scripts decode-stack --maps <dir> [--file stack.txt]');
  const stack = values.file ? readFileSync(values.file, 'utf8') : readFileSync(0, 'utf8');
  console.log(decodeStack(stack, dirLoader(values.maps)));
}
