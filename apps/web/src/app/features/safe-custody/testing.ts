import type { InMemoryFirestore } from '@materia/data-access/repository';
import {
  DomainError,
  formatPacketNo,
  GET_EXPORT_URL_CALLABLE,
  locationKey,
  MOVEMENT_TRANSITIONS,
  packetSearchTokens,
  SAFE_CUSTODY_CALLABLES,
  type RecordableMovement,
  type SafeCustodyLocation,
  type SafeCustodyStatus,
} from '@materia/domain';

import { storedDocument } from '../documents/testing';
import { MATTER, ME, meta, ORG, type FakeCallable } from '../matter-detail/testing';

/**
 * Fixtures and fake `safeCustody-*` callables for the register's specs (CORE-17). The fakes write
 * what the server would, so the live queries show the change. Fictional data only.
 */

type Seed = Record<string, unknown>;

export const PACKETS = `orgs/${ORG}/safeCustody`;
export const AUTHORITY_DOC = 'd-authority';
const AT = new Date('2026-09-02T00:00:00Z');

/** A stored packet as the server keeps it. */
export function packetDoc(seq: number, testatorName: string, data: Seed = {}): Seed {
  const packetNo = formatPacketNo(seq);
  const location = (data['location'] as SafeCustodyLocation | undefined) ?? {
    site: 'Geelong',
    cabinet: 'Safe A',
    slot: String(seq),
  };
  return {
    packetNo,
    testatorContactId: 'c-bram',
    testatorName,
    responsibleUid: ME,
    items: [{ kind: 'will', date: '2019-02-14', description: 'Last will' }],
    location,
    receivedOn: '2019-03-01',
    status: 'held',
    movements: [{ at: AT, by: ME, kind: 'in', reason: 'Received into safe custody', location }],
    pendingDestruction: null,
    search: packetSearchTokens(packetNo, testatorName, location),
    locationKey: locationKey(location),
    deletedAt: null,
    ...meta,
    ...data,
  };
}

/** Three packets: Bram's (held, two originals), Margaret's (held, on the Whitfield matter) and an old released one. */
export function seedPackets(fs: InMemoryFirestore): void {
  fs.set(
    `${PACKETS}/sc-bram`,
    packetDoc(1, 'Bram Ostler', {
      items: [
        { kind: 'will', date: '2019-02-14', description: 'Last will' },
        { kind: 'codicil', date: '2021-06-01', description: '' },
        { kind: 'poa', date: '2019-02-14', description: '' },
      ],
    }),
  );
  fs.set(
    `${PACKETS}/sc-margaret`,
    packetDoc(2, 'Margaret Whitfield', {
      testatorContactId: 'c-margaret',
      matterId: 'm-whitfield',
      location: { site: 'Melbourne', cabinet: 'Strongroom', slot: '12' },
    }),
  );
  fs.set(`${PACKETS}/sc-old`, packetDoc(3, 'Wilfred Larch', { testatorContactId: 'c-larch', status: 'released' }));
  fs.set(`${MATTER}/documents/${AUTHORITY_DOC}`, storedDocument(AUTHORITY_DOC, 'Signed authority.pdf'));
}

const refuse = (reason: string): never => {
  throw new DomainError('FAILED_PRECONDITION', reason, { reason });
};

/** The `safeCustody-*` callables and `jobs-getExportUrl`, as the server behaves (roles aside). */
export function safeCustodyServerCallables(uid = ME): Record<string, FakeCallable> {
  let seq = 10;
  const clock = () => new Date('2026-10-04T02:00:00Z');
  const load = (fs: InMemoryFirestore, id: unknown) => {
    const packet = fs.get(`${PACKETS}/${String(id)}`) as Seed | undefined;
    if (!packet) throw new DomainError('NOT_FOUND', 'Packet not found');
    return packet;
  };
  const save = (fs: InMemoryFirestore, id: unknown, packet: Seed) =>
    fs.set(`${PACKETS}/${String(id)}`, { ...packet, updatedAt: clock(), updatedBy: uid });
  return {
    [SAFE_CUSTODY_CALLABLES.receive]: (data, fs) => {
      const id = `sc-new-${++seq}`;
      const contact = fs.get(`orgs/${ORG}/contacts/${String(data['testatorContactId'])}`) as Seed;
      const name = `${String(contact['givenNames'])} ${String(contact['familyName'])}`;
      const location = data['location'] as SafeCustodyLocation;
      fs.set(
        `${PACKETS}/${id}`,
        packetDoc(seq, name, {
          testatorContactId: data['testatorContactId'],
          responsibleUid: data['responsibleUid'] ?? uid,
          items: data['items'],
          location,
          receivedOn: data['receivedOn'],
          movements: [{ at: clock(), by: uid, kind: 'in', reason: 'Received into safe custody', location }],
          ...(data['matterId'] ? { matterId: data['matterId'] } : {}),
          ...(data['notes'] ? { notes: data['notes'] } : {}),
        }),
      );
      return { id, packetNo: formatPacketNo(seq) };
    },
    [SAFE_CUSTODY_CALLABLES.update]: (data, fs) => {
      const packet = load(fs, data['id']);
      const { id, matterId, ...patch } = data;
      delete patch['requestId'];
      const next: Seed = { ...packet, ...patch };
      if (matterId === null) delete next['matterId'];
      else if (matterId) next['matterId'] = matterId;
      save(fs, id, next);
      return { id };
    },
    [SAFE_CUSTODY_CALLABLES.recordMovement]: (data, fs) => {
      const packet = load(fs, data['id']);
      if (packet['pendingDestruction']) refuse('destruction_pending');
      const kind = data['kind'] as RecordableMovement;
      const transition = MOVEMENT_TRANSITIONS[kind];
      if (!transition.from.includes(packet['status'] as SafeCustodyStatus)) refuse('invalid_movement');
      const movement: Seed = { ...data };
      delete movement['id'];
      delete movement['requestId'];
      if (kind === 'destroyed') {
        save(fs, data['id'], {
          ...packet,
          pendingDestruction: {
            requestedBy: uid,
            requestedAt: clock(),
            authority: data['authority'],
            reason: data['reason'],
          },
        });
        return { status: packet['status'], pendingConfirmation: true };
      }
      save(fs, data['id'], {
        ...packet,
        status: transition.to,
        movements: [...(packet['movements'] as Seed[]), { at: clock(), by: uid, ...movement }],
        ...(kind === 'returned' && data['location'] ? { location: data['location'] } : {}),
      });
      return { status: transition.to, pendingConfirmation: false };
    },
    [SAFE_CUSTODY_CALLABLES.confirmDestruction]: (data, fs) => {
      const packet = load(fs, data['id']);
      const pending = packet['pendingDestruction'] as Seed | null;
      if (!pending) return refuse('no_pending_destruction');
      if (!data['approve']) {
        save(fs, data['id'], { ...packet, pendingDestruction: null });
        return { status: packet['status'], pendingConfirmation: false };
      }
      if (pending['requestedBy'] === uid) {
        throw new DomainError('PERMISSION_DENIED', 'same person', { reason: 'same_person' });
      }
      save(fs, data['id'], {
        ...packet,
        status: 'destroyed',
        pendingDestruction: null,
        movements: [
          ...(packet['movements'] as Seed[]),
          {
            at: clock(),
            by: pending['requestedBy'],
            kind: 'destroyed',
            reason: pending['reason'],
            authority: pending['authority'],
            approvedBy: uid,
          },
        ],
      });
      return { status: 'destroyed', pendingConfirmation: false };
    },
    [SAFE_CUSTODY_CALLABLES.verify]: (data, fs) => {
      const verified: string[] = [];
      const skipped: string[] = [];
      for (const id of data['ids'] as string[]) {
        const packet = load(fs, id);
        if (packet['status'] !== 'held') {
          skipped.push(id);
          continue;
        }
        save(fs, id, { ...packet, lastVerified: { on: data['on'], by: uid } });
        verified.push(id);
      }
      return { verified, skipped };
    },
    [SAFE_CUSTODY_CALLABLES.receipt]: () => ({ jobId: 'job-receipt' }),
    [SAFE_CUSTODY_CALLABLES.stocktakeReport]: () => ({ jobId: 'job-stocktake' }),
    [GET_EXPORT_URL_CALLABLE]: (data) => ({
      url: `https://storage.example.test/${String(data['jobId'])}.pdf`,
      expiresAt: '2026-10-04T02:05:00.000Z',
      fileName: 'Safe custody receipt.pdf',
    }),
  };
}
