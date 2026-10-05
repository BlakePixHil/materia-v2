import type { Firestore } from 'firebase-admin/firestore';

import type { FileStore } from './files';
import type { AfterVersion } from './pipeline';
import type { Log } from '../core/log';
import type { Clock, Ports } from '../ports';

export interface RenditionDeps {
  db: Firestore;
  files: FileStore;
  ports: Ports;
  log: Log;
  clock: Clock;
}

/** Starts the renditions a new version needs (CORE-12). Best effort: the version is already stored. */
export async function startRenditions(deps: RenditionDeps, stored: Parameters<AfterVersion>[0]): Promise<void> {
  deps.log.info('no renditions', { docId: stored.docId, version: stored.version.version, kind: stored.kind });
}
