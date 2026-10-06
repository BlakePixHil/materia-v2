import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, httpsCallable, type FunctionsError } from 'firebase/functions';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore as getAdminFirestore, type Firestore } from 'firebase-admin/firestore';

import { addDays, today, type Role } from '@materia/domain';

/**
 * BILL-08 through the emulators: payments (part paid, then paid), a reversal (back to issued), the
 * matter's outstanding amount following through `billing-outstandingOnInvoice`, and the aged-debtors
 * rollup with its reminder queue (`billing-refreshDebtors`), dismissed by hand. Everything is fictional.
 */
const PROJECT_ID = 'demo-materia';
const ORG = 'org-payments';
const PASSWORD = 'fictional-password-p8';
const MATTER_ID = 'm-pay';
const MATTER = `orgs/${ORG}/matters/${MATTER_ID}`;
const INVOICE_ID = 'inv-pay-1';
const INVOICE = `orgs/${ORG}/invoices/${INVOICE_ID}`;
const TOTAL = 110_000;

let admin: App;
let db: Firestore;
let client: FirebaseApp;
let auth: Auth;

const uidOf = (role: Role) => `pay-${role}`;
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
  await db.doc(`orgs/${ORG}/members/${uidOf(role)}`).set({ role, status: 'active', displayName, rates: [] });
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
const recordPayment = callable<{ paymentId: string; status: string; owingCents: number; warnings: string[] }>(
  'billing-recordPayment',
);
const reversePayment = callable<{ reversed: boolean; status: string; owingCents: number }>('billing-reversePayment');
const refreshDebtors = callable<{ asOf: string; invoices: number; totalCents: number }>('billing-refreshDebtors');
const dismissReminder = callable<{ dismissed: boolean }>('billing-dismissReminder');

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
const outstanding = (expected: number) =>
  poll(
    async () => (await data(MATTER))['outstandingCents'],
    (value) => value === expected,
  );

const todayDate = today('Australia/Melbourne');
// Issued 40 days ago on 14-day terms: 26 days overdue (the 7-day reminder, the 1–30 bucket).
const ISSUED = addDays(todayDate, -40);
const DUE = addDays(todayDate, -26);

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'payments-admin');
  db = getAdminFirestore(admin);
  const adminAuth = getAdminAuth(admin);
  const existing = await adminAuth.listUsers();
  await Promise.all(existing.users.filter((u) => u.uid.startsWith('pay-')).map((u) => adminAuth.deleteUser(u.uid)));
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await db.doc(`orgs/${ORG}`).set({
    name: 'Harbour & Vine Legal (fictional)',
    timezone: 'Australia/Melbourne',
    billing: { gstRegistered: true, invoicePrefix: 'INV-', paymentTermsDays: 14 },
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
  await db.doc(MATTER).set({
    number: 'M-2026-0800',
    title: 'Estate of Fictional Finch',
    type: 'probate',
    status: 'open',
    privileged: false,
    clientContactIds: ['c-lan'],
    responsibleUid: uidOf('lawyer'),
    wipCents: 0,
    deletedAt: null,
    ...meta,
  });
  await db.doc(INVOICE).set({
    number: 'INV-000801',
    matterId: MATTER_ID,
    matterNumber: 'M-2026-0800',
    matterTitle: 'Estate of Fictional Finch',
    paymentTermsDays: 14,
    issueDate: ISSUED,
    dueDate: DUE,
    lines: [
      { kind: 'fixed_fee', description: 'Grant of probate', quantity: 1, amountExGstCents: 100_000, gstCents: 10_000 },
    ],
    subtotalCents: 100_000,
    gstCents: 10_000,
    totalCents: TOTAL,
    gstRegistered: true,
    buyer: { name: 'Lan Nguyễn' },
    status: 'issued',
    creditNoteIds: [],
    creditedCents: 0,
    payments: [],
    ...meta,
  });

  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'payments-client');
  auth = getAuth(client);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFunctionsEmulator(getFunctions(client, 'australia-southeast1'), '127.0.0.1', 5001);
});

afterAll(async () => {
  await signOut(auth);
  await deleteApp(client);
  await deleteAdminApp(admin);
});

describe('payments and reversal', () => {
  it('moves the invoice and the matter’s outstanding amount with each payment', async () => {
    await signInAs('lawyer');
    const part = await recordPayment({ invoiceId: INVOICE_ID, date: todayDate, amountCents: 40_000, method: 'eft' });
    expect(part).toMatchObject({ status: 'part_paid', owingCents: 70_000, warnings: [] });
    expect(await outstanding(70_000)).toBe(70_000);

    const over = (await recordPayment({
      invoiceId: INVOICE_ID,
      date: todayDate,
      amountCents: 80_000,
      method: 'eft',
    }).catch((error: unknown) => error)) as FunctionsError;
    expect(over.code).toBe('functions/failed-precondition');

    const early = await recordPayment({
      invoiceId: INVOICE_ID,
      date: addDays(ISSUED, -1),
      amountCents: 70_000,
      method: 'cheque',
      reference: '000777',
      payer: 'Sam Finch (executor)',
    });
    expect(early).toMatchObject({ status: 'paid', owingCents: 0, warnings: ['before_issue'] });
    expect(await outstanding(0)).toBe(0);

    // The cheque bounces: an owner reverses it, with why.
    const lawyerTry = (await reversePayment({
      invoiceId: INVOICE_ID,
      paymentId: early.paymentId,
      reason: 'Cheque dishonoured',
    }).catch((error: unknown) => error)) as FunctionsError;
    expect(lawyerTry.code).toBe('functions/permission-denied');
    await signInAs('owner');
    const reversed = await reversePayment({
      invoiceId: INVOICE_ID,
      paymentId: early.paymentId,
      reason: 'Cheque dishonoured',
    });
    expect(reversed).toEqual({ reversed: true, status: 'part_paid', owingCents: 70_000 });
    expect(await data(INVOICE)).toMatchObject({
      status: 'part_paid',
      payments: [
        { amountCents: 40_000 },
        { id: early.paymentId, reversedBy: uidOf('owner'), reversalReason: 'Cheque dishonoured' },
      ],
    });
    expect(await outstanding(70_000)).toBe(70_000);
    const audit = await db.collection(`orgs/${ORG}/audit`).where('action', '==', 'invoice.payment_reversed').get();
    expect(audit.size).toBe(1);
  }, 120_000);
});

describe('aged debtors and reminders', () => {
  it('rolls the debt up by age and queues a reminder for the lawyer, unsent', async () => {
    await signInAs('lawyer');
    const result = await refreshDebtors({});
    expect(result).toEqual({ asOf: todayDate, invoices: 1, totalCents: 70_000 });
    expect(await data(`orgs/${ORG}/metrics/debtors-${todayDate}`)).toMatchObject({
      period: `debtors-${todayDate}`,
      values: { d1_30: 70_000, total: 70_000, invoices: 1, matters: 1 },
      debtors: { asOf: todayDate, rows: [{ matterId: MATTER_ID, clientName: 'Lan Nguyễn', invoices: 1 }] },
    });
    const reminderId = `${INVOICE_ID}-7`;
    expect(await data(`orgs/${ORG}/invoiceReminders/${reminderId}`)).toMatchObject({
      status: 'pending',
      threshold: 7,
      lawyerUid: uidOf('lawyer'),
      balanceCents: 70_000,
      to: ['lan.fictional@example.com'],
    });
    expect(await dismissReminder({ reminderId, reason: 'Client called; paying Friday' })).toEqual({ dismissed: true });
    expect(await data(`orgs/${ORG}/invoiceReminders/${reminderId}`)).toMatchObject({
      status: 'dismissed',
      closedBy: uidOf('lawyer'),
    });
  }, 60_000);
});
