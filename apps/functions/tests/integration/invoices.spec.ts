import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, httpsCallable, type FunctionsError } from 'firebase/functions';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore as getAdminFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

import { invoiceTotals, type InvoiceLine, type Role } from '@materia/domain';

/**
 * BILL-07 through the emulators: pre-bills, gapless numbering under 20 concurrent issues, issuing
 * (time and disbursements billed, WIP and the budget follow through their triggers), the PDF job's
 * outcome, sending with the PDF attached, voiding (WIP restored) and credit notes (the budget's
 * billed amount less credits). Everything is fictional.
 */
const PROJECT_ID = 'demo-materia';
const ORG = 'org-invoices';
const PASSWORD = 'fictional-password-i7';
const MATTER_ID = 'm-inv';
const MATTER = `orgs/${ORG}/matters/${MATTER_ID}`;
const PARALLEL = 20;

let admin: App;
let db: Firestore;
let client: FirebaseApp;
let auth: Auth;

const uidOf = (role: Role) => `inv-${role}`;
const meta = {
  createdAt: FieldValue.serverTimestamp(),
  createdBy: 'seed',
  updatedAt: FieldValue.serverTimestamp(),
  updatedBy: 'seed',
  schemaVersion: 1,
};

async function createMember(role: Role, displayName: string) {
  const adminAuth = getAdminAuth(admin);
  await adminAuth.createUser({ uid: uidOf(role), email: `${uidOf(role)}@example.test`, password: PASSWORD });
  await adminAuth.setCustomUserClaims(uidOf(role), { orgId: ORG, role });
  await db
    .doc(`orgs/${ORG}/members/${uidOf(role)}`)
    .set({ role, status: 'active', displayName, defaultRateCents: 44_000, rates: [] });
}

async function signInAs(role: Role) {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, `${uidOf(role)}@example.test`, PASSWORD);
}

function callable<T>(name: string) {
  return (input: Record<string, unknown>) =>
    httpsCallable<Record<string, unknown>, T>(
      getFunctions(client, 'australia-southeast1'),
      name,
    )({
      requestId: randomUUID(),
      ...input,
    }).then((result) => result.data);
}
const saveDraft = callable<{ invoiceId: string; totalCents: number }>('billing-saveDraft');
const issue = callable<{ invoiceId: string; number: string; totalCents: number }>('billing-issueInvoice');
const voidInvoice = callable<{ released: number }>('billing-voidInvoice');
const creditNote = callable<{ creditNoteId: string; number: string; totalCents: number }>('billing-createCreditNote');
const send = callable<{ sent: number }>('billing-sendInvoice');

async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    value = await read();
  }
  return value;
}

const data = async (path: string) => (await db.doc(path).get()).data() ?? {};

const matter = (id: string, number: string) => ({
  number,
  title: `Estate of Fictional Wren ${number}`,
  type: 'probate',
  status: 'open',
  privileged: false,
  clientContactIds: ['c-lan'],
  responsibleUid: uidOf('lawyer'),
  fee: { arrangement: 'hourly', history: [] },
  wipCents: 0,
  deletedAt: null,
  ...meta,
});

const entry = (amountCents: number, extra: Record<string, unknown> = {}) => ({
  orgId: ORG,
  matterId: MATTER_ID,
  uid: uidOf('lawyer'),
  date: '2026-09-01',
  minutes: 60,
  units: 10,
  rateCents: 44_000,
  amountCents,
  narrative: 'Advice to the executor (fictional)',
  billable: true,
  status: 'final',
  source: 'manual',
  deletedAt: null,
  ...meta,
  ...extra,
});

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID, storageBucket: `${PROJECT_ID}.appspot.com` }, 'invoices-admin');
  db = getAdminFirestore(admin);
  const adminAuth = getAdminAuth(admin);
  const existing = await adminAuth.listUsers();
  await Promise.all(existing.users.filter((u) => u.uid.startsWith('inv-')).map((u) => adminAuth.deleteUser(u.uid)));
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await db.doc(`orgs/${ORG}`).set({
    name: 'Harbour & Vine Legal (fictional)',
    abn: '12345678901',
    timezone: 'Australia/Melbourne',
    billing: {
      unitMinutes: 6,
      rounding: 'up',
      defaultRateCents: 44_000,
      gstRegistered: true,
      invoicePrefix: 'INV-',
      paymentTermsDays: 14,
    },
    flags: { 'billing.invoicing': true },
  });
  await createMember('lawyer', 'Pat Lawyer');
  await createMember('owner', 'Olive Owner');
  await db.doc(`orgs/${ORG}/contacts/c-lan`).set({
    kind: 'person',
    givenNames: 'Lan',
    familyName: 'Nguyễn',
    emails: [{ type: 'personal', address: 'lan.fictional@example.com' }],
    addresses: [],
    ...meta,
  });
  await db.doc(MATTER).set(matter(MATTER_ID, 'M-2026-0700'));
  for (let i = 0; i < PARALLEL; i++) await db.doc(`orgs/${ORG}/matters/m-par-${i}`).set(matter(`m-par-${i}`, `P-${i}`));

  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'invoices-client');
  auth = getAuth(client);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFunctionsEmulator(getFunctions(client, 'australia-southeast1'), '127.0.0.1', 5001);
});

afterAll(async () => {
  await signOut(auth);
  await deleteApp(client);
  await deleteAdminApp(admin);
});

describe('billing-issueInvoice numbering', () => {
  it(`gives ${PARALLEL} concurrent issues consecutive numbers: no gaps, no repeats`, async () => {
    await signInAs('lawyer');
    const drafts = [];
    for (let i = 0; i < PARALLEL; i++) {
      drafts.push(
        await saveDraft({
          matterId: `m-par-${i}`,
          fields: { extraLines: [{ kind: 'fixed_fee', description: `Fixed fee ${i}`, amountExGstCents: 10_000 + i }] },
        }),
      );
    }
    const issued = await Promise.all(drafts.map((draft) => issue({ invoiceId: draft.invoiceId })));
    const numbers = issued.map((result) => result.number).sort();
    expect(numbers).toEqual(Array.from({ length: PARALLEL }, (_, i) => `INV-${String(i + 1).padStart(6, '0')}`));
    expect(await data(`orgs/${ORG}/counters/invoice`)).toMatchObject({ next: PARALLEL + 1 });
    for (const result of issued) {
      expect(await data(`orgs/${ORG}/invoices/${result.invoiceId}`)).toMatchObject({
        number: result.number,
        status: 'issued',
      });
    }
  }, 120_000);

  it('doesn’t use a number up when the issue fails', async () => {
    await signInAs('lawyer');
    const { invoiceId } = await saveDraft({
      matterId: 'm-par-0',
      fields: { extraLines: [{ kind: 'adjustment', description: 'Credit owing', amountExGstCents: -500 }] },
    });
    const failure = (await issue({ invoiceId }).catch((error: unknown) => error)) as FunctionsError;
    expect(failure.code).toBe('functions/failed-precondition');
    expect(await data(`orgs/${ORG}/counters/invoice`)).toMatchObject({ next: PARALLEL + 1 });
  });
});

describe('issue, PDF, send, void and credit notes', () => {
  const ITEMS = [44_000, 13_200];

  it('keeps WIP, the budget and the totals consistent from pre-bill to credit note', async () => {
    for (const [i, amount] of ITEMS.entries()) await db.doc(`${MATTER}/timeEntries/t${i}`).set(entry(amount));
    await db.doc(`${MATTER}/disbursements/d0`).set({
      orgId: ORG,
      matterId: MATTER_ID,
      date: '2026-09-02',
      description: 'Probate filing fee',
      payee: 'Supreme Court of Victoria',
      amountExGstCents: 33_310,
      gstCents: 0,
      amountIncGstCents: null,
      gstTreatment: 'gst_free',
      status: 'unbilled',
      deletedAt: null,
      ...meta,
    });
    const wip = () => data(MATTER);
    expect(await poll(wip, (m) => m['wipCents'] === 57_200 && m['disbursementWipCents'] === 33_310)).toMatchObject({
      wipCents: 57_200,
      disbursementWipCents: 33_310,
    });

    // Pre-bill and issue.
    await signInAs('lawyer');
    const draft = await saveDraft({ matterId: MATTER_ID });
    const expected = 44_000 + 4_400 + 13_200 + 1_320 + 33_310;
    expect(draft.totalCents).toBe(expected);
    const issued = await issue({ invoiceId: draft.invoiceId });
    expect(issued).toMatchObject({ totalCents: expected });
    const path = `orgs/${ORG}/invoices/${draft.invoiceId}`;
    const invoice = await data(path);
    expect(invoice).toMatchObject({ status: 'issued', buyer: { name: 'Lan Nguyễn' }, pdfStatus: 'pending' });
    expect(invoiceTotals(invoice['lines'] as InvoiceLine[]).totalCents).toBe(invoice['totalCents']);
    for (const id of ['t0', 't1']) {
      expect(await data(`${MATTER}/timeEntries/${id}`)).toMatchObject({ status: 'billed', invoiceId: draft.invoiceId });
    }
    expect(
      await poll(
        wip,
        (m) => m['wipCents'] === 0 && m['disbursementWipCents'] === 0 && m['budget']?.billedCents === 90_510,
      ),
    ).toMatchObject({
      wipCents: 0,
      disbursementWipCents: 0,
      budget: { billedCents: 90_510 },
      lastInvoicedOn: invoice['issueDate'],
    });

    // The PDF job (the emulator doesn't run Cloud Run): its success lands on the invoice.
    const jobId = String(invoice['pdfJobId']);
    const job = await data(`orgs/${ORG}/jobs/${jobId}`);
    expect(job).toMatchObject({ type: 'pdf.render', input: { templateId: 'invoice' } });
    const storagePath = `${MATTER}/documents/job-${jobId}/v1`;
    await getStorage(admin).bucket().file(storagePath).save(Buffer.from('%PDF-1.7 fictional'), {
      contentType: 'application/pdf',
    });
    await db.doc(`${MATTER}/documents/job-${jobId}`).set({ storagePath, version: 1, ...meta });
    await db.doc(`orgs/${ORG}/jobs/${jobId}`).update({
      status: 'succeeded',
      output: { storagePath, sizeBytes: 18, sha256: '0'.repeat(64), pages: 1, documentId: `job-${jobId}` },
    });
    expect(
      await poll(
        () => data(path),
        (i) => i['pdfStatus'] === 'ready',
      ),
    ).toMatchObject({
      pdfStatus: 'ready',
      pdfDocumentId: `job-${jobId}`,
    });

    // Send it, with the PDF attached (the emulator's outbox lists attachments).
    expect(
      await send({ invoiceId: draft.invoiceId, to: ['lan.fictional@example.com'], message: 'Fictional.' }),
    ).toEqual({
      sent: 1,
    });
    const outbox = await db.collection('emulatorOutbox').where('to', '==', 'lan.fictional@example.com').get();
    expect(outbox.docs.map((d) => d.data())).toContainEqual(
      expect.objectContaining({
        template: 'invoice',
        attachments: [expect.objectContaining({ name: `Tax invoice ${issued.number}.pdf`, sizeBytes: 18 })],
      }),
    );
    expect(await data(path)).toMatchObject({ sentTo: ['lan.fictional@example.com'] });

    // Void: the number stays, the work goes back to WIP and the budget's billed amount drops.
    await signInAs('owner');
    expect(await voidInvoice({ invoiceId: draft.invoiceId, reason: 'Issued to the wrong client' })).toEqual({
      invoiceId: draft.invoiceId,
      released: 3,
    });
    expect(await data(path)).toMatchObject({ status: 'void', number: issued.number });
    expect(
      await poll(
        wip,
        (m) => m['wipCents'] === 57_200 && m['disbursementWipCents'] === 33_310 && m['budget']?.billedCents === 0,
      ),
    ).toMatchObject({ wipCents: 57_200, disbursementWipCents: 33_310, budget: { billedCents: 0 } });

    // Bill it again, then credit part of it: the work stays billed, the budget counts the credit.
    await signInAs('lawyer');
    const again = await saveDraft({ matterId: MATTER_ID });
    const second = await issue({ invoiceId: again.invoiceId });
    expect(second.number).not.toBe(issued.number);
    await poll(wip, (m) => m['wipCents'] === 0 && m['budget']?.billedCents === 90_510);
    await signInAs('owner');
    const credit = await creditNote({
      invoiceId: again.invoiceId,
      reason: 'Fee reduced',
      lines: [{ line: 0, amountExGstCents: 4_000 }],
    });
    expect(credit).toMatchObject({ number: 'CN-000001', totalCents: 4_400 });
    expect(await data(`orgs/${ORG}/invoices/${again.invoiceId}`)).toMatchObject({ creditedCents: 4_400 });
    expect(await poll(wip, (m) => m['budget']?.billedCents === 86_510)).toMatchObject({
      wipCents: 0,
      budget: { billedCents: 86_510 },
    });
    // A credited invoice is corrected with credit notes, not voided.
    const refused = (await voidInvoice({ invoiceId: again.invoiceId, reason: 'x' }).catch(
      (e: unknown) => e,
    )) as FunctionsError;
    expect(refused.code).toBe('functions/failed-precondition');
    const full = await creditNote({ invoiceId: again.invoiceId, reason: 'Written off', full: true });
    expect(full.number).toBe('CN-000002');
    expect((await data(`orgs/${ORG}/invoices/${again.invoiceId}`))['creditedCents']).toBe(second.totalCents);
  }, 180_000);
});
