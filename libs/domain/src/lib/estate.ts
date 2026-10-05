import * as z from 'zod';

import { DocIdSchema } from './schemas/common';
import type { MatterType } from './schemas/enums';
import {
  SHARE_BPS_WHOLE,
  type AssetClass,
  type AssetStatus,
  type DistributionKind,
  type DistributionStatus,
  type JointHolding,
  type LiabilityClass,
  type LiabilityStatus,
} from './schemas/matter-records';
import type { DateOnly } from './values/date-only';
import { cents, formatCents, type Cents } from './values/money';

/**
 * The estate register (CORE-16): a probate, administration or trust matter's assets, liabilities
 * and distributions, the totals `estate-onWrite` keeps on the matter, the residue shown (never
 * enforced) to the person planning distributions, and the inventory schedule exported as CSV and
 * PDF. Every amount is integer AUD cents. The asset classes and the summary wording await
 * practitioner review (CORE-16a), so the register ships behind `estate.register`.
 */

/** The matter types with an Estate tab. */
export const ESTATE_REGISTER_TYPES: readonly MatterType[] = ['probate', 'loa', 'admin', 'trust'];

export const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  real_property: 'Real property',
  bank: 'Bank accounts',
  shares: 'Shares and investments',
  superannuation: 'Superannuation',
  insurance: 'Insurance policies',
  vehicle: 'Vehicles',
  personal: 'Personal property',
  business: 'Business interests',
  debt_owed_to_estate: 'Debts owed to the estate',
  other: 'Other assets',
};

export const ASSET_STATUS_LABELS: Record<AssetStatus, string> = {
  identified: 'Identified',
  valued: 'Valued',
  realised: 'Realised',
  transferred: 'Transferred',
};

export const JOINT_HOLDING_LABELS: Record<JointHolding, string> = {
  joint_tenants: 'Joint tenants',
  tenants_in_common: 'Tenants in common',
};

export const LIABILITY_CLASS_LABELS: Record<LiabilityClass, string> = {
  funeral: 'Funeral expenses',
  tax: 'Tax',
  debt: 'Debts',
  mortgage: 'Mortgages',
  costs: 'Legal and administration costs',
  other: 'Other liabilities',
};

export const LIABILITY_STATUS_LABELS: Record<LiabilityStatus, string> = {
  notified: 'Notified',
  paid: 'Paid',
  disputed: 'Disputed',
};

export const DISTRIBUTION_KIND_LABELS: Record<DistributionKind, string> = {
  specific: 'Specific gift',
  pecuniary: 'Pecuniary gift',
  residuary: 'Residuary gift',
};

export const DISTRIBUTION_STATUS_LABELS: Record<DistributionStatus, string> = {
  planned: 'Planned',
  approved: 'Approved',
  paid: 'Paid',
  cancelled: 'Cancelled',
};

/** The practitioner note shown on an insolvent estate (CORE-16a reviews the wording). */
export const INSOLVENT_ESTATE_NOTE =
  'The liabilities exceed the assets, so this estate appears insolvent. Insolvent administration rules apply to the order in which debts are paid; check them before paying any creditor or beneficiary. Distributions are disabled while the net estate is negative.';

/** Why the "outside the estate" total is shown separately (CORE-16a reviews the wording). */
export const OUTSIDE_ESTATE_NOTE =
  'Assets passing outside the estate (superannuation paid under a nomination, joint tenancy, nominated policies) are not distributed under the will. Victoria has no notional estate regime; they matter for advice and in jurisdictions that have one, such as NSW.';

// ---------- the parts the maths reads ----------

export interface AssetValues {
  valueAtDeathCents: number;
  shareBps?: number | undefined;
  passesOutsideEstate: boolean;
  realisedCents?: number | undefined;
  deletedAt?: unknown;
}

export interface LiabilityValues {
  amountCents: number;
  deletedAt?: unknown;
}

export interface DistributionValues {
  kind: DistributionKind;
  status: DistributionStatus;
  amountCents?: number | undefined;
  assetId?: string | undefined;
  deletedAt?: unknown;
}

const live = <T extends { deletedAt?: unknown }>(rows: readonly T[]): T[] => rows.filter((row) => !row.deletedAt);

/** `numerator / denominator` rounded half away from zero (for non-negative values, half up). */
function divRound(numerator: number, denominator: number): number {
  const quotient = Math.floor(numerator / denominator);
  return numerator - quotient * denominator >= denominator / 2 ? quotient + 1 : quotient;
}

/**
 * What an asset is worth to the estate: the value at the date of death, or the deceased's share of
 * it (`shareBps`), rounded to the cent.
 */
export function assetShareCents(asset: Pick<AssetValues, 'valueAtDeathCents' | 'shareBps'>): Cents {
  const share = asset.shareBps ?? SHARE_BPS_WHOLE;
  return cents(
    share === SHARE_BPS_WHOLE ? asset.valueAtDeathCents : divRound(asset.valueAtDeathCents * share, SHARE_BPS_WHOLE),
  );
}

/**
 * Whether an asset passes outside the estate by default: a joint tenancy passes by survivorship,
 * tenants in common hold a share that is in the estate. Other assets default to in the estate; a
 * person marks superannuation and nominated policies themselves.
 */
export function defaultPassesOutside(jointlyHeld: boolean, holding: JointHolding | undefined): boolean {
  return jointlyHeld && holding === 'joint_tenants';
}

/** The register's totals, as `estate-onWrite` stores them on `matter.estateRegister`. */
export interface EstateTotals {
  /** Assets in the estate (not passing outside it), at the estate's share of their value. */
  grossCents: Cents;
  liabilitiesCents: Cents;
  /** Gross less liabilities; negative when the estate is insolvent. */
  netCents: Cents;
  /** Assets passing outside the estate, shown separately. */
  outsideCents: Cents;
  /** Realised so far: the realised amounts of assets in the estate. */
  realisedCents: Cents;
  assetCount: number;
  liabilityCount: number;
}

/** The totals of the live (not deleted) assets and liabilities. */
export function estateTotals(assets: readonly AssetValues[], liabilities: readonly LiabilityValues[]): EstateTotals {
  let gross = 0;
  let outside = 0;
  let realised = 0;
  const liveAssets = live(assets);
  for (const asset of liveAssets) {
    const value = assetShareCents(asset);
    if (asset.passesOutsideEstate) {
      outside += value;
    } else {
      gross += value;
      realised += asset.realisedCents ?? 0;
    }
  }
  const liveLiabilities = live(liabilities);
  const owed = liveLiabilities.reduce((sum, liability) => sum + liability.amountCents, 0);
  return {
    grossCents: cents(gross),
    liabilitiesCents: cents(owed),
    netCents: cents(gross - owed),
    outsideCents: cents(outside),
    realisedCents: cents(realised),
    assetCount: liveAssets.length,
    liabilityCount: liveLiabilities.length,
  };
}

export const EMPTY_ESTATE_TOTALS: EstateTotals = estateTotals([], []);

/** The same totals (to skip a write that would change nothing). */
export function sameEstateTotals(a: Partial<EstateTotals> | undefined, b: EstateTotals): boolean {
  return !!a && (Object.keys(b) as (keyof EstateTotals)[]).every((key) => a[key] === b[key]);
}

/** A net estate below zero: insolvent administration rules apply and distributions are disabled. */
export const isInsolvent = (totals: Pick<EstateTotals, 'netCents'>): boolean => totals.netCents < 0;

/**
 * What a distribution takes from the estate: its amount, else (a specific gift of an asset) the
 * estate's share of that asset's value. A residuary gift takes no fixed amount.
 */
export function distributionCents(
  distribution: DistributionValues,
  assets: ReadonlyMap<string, Pick<AssetValues, 'valueAtDeathCents' | 'shareBps'>>,
): Cents {
  if (distribution.amountCents !== undefined) return cents(distribution.amountCents);
  if (distribution.kind === 'specific' && distribution.assetId) {
    const asset = assets.get(distribution.assetId);
    return asset ? assetShareCents(asset) : cents(0);
  }
  return cents(0);
}

/** The residue calculation the Distributions section shows (it is shown, not enforced). */
export interface ResidueCalculation {
  netCents: Cents;
  specificCents: Cents;
  pecuniaryCents: Cents;
  reservedCents: Cents;
  /** Net less specific and pecuniary gifts and reserves; negative when the gifts can't all be met. */
  residueCents: Cents;
  /** Paid so far, every kind. */
  paidCents: Cents;
}

/** Net estate minus specific and pecuniary gifts (cancelled ones aside) minus the reserve. */
export function residueCalculation(
  netCents: number,
  distributions: readonly DistributionValues[],
  assets: ReadonlyMap<string, Pick<AssetValues, 'valueAtDeathCents' | 'shareBps'>>,
  reservedCents = 0,
): ResidueCalculation {
  let specific = 0;
  let pecuniary = 0;
  let paid = 0;
  for (const distribution of live(distributions)) {
    if (distribution.status === 'cancelled') continue;
    const value = distributionCents(distribution, assets);
    if (distribution.kind === 'specific') specific += value;
    if (distribution.kind === 'pecuniary') pecuniary += value;
    if (distribution.status === 'paid') paid += value;
  }
  return {
    netCents: cents(netCents),
    specificCents: cents(specific),
    pecuniaryCents: cents(pecuniary),
    reservedCents: cents(reservedCents),
    residueCents: cents(netCents - specific - pecuniary - reservedCents),
    paidCents: cents(paid),
  };
}

/**
 * Whether an asset write changes what the estate is worth (created, deleted or restored, or its
 * value, share, outside flag or realised amount changed). Distributions recorded before such a
 * change are flagged for review.
 */
export function assetValueChanged(before: AssetValues | undefined, after: AssetValues | undefined): boolean {
  const worth = (asset: AssetValues | undefined) =>
    !asset || asset.deletedAt
      ? null
      : `${assetShareCents(asset)}|${asset.passesOutsideEstate}|${asset.realisedCents ?? ''}`;
  return worth(before) !== worth(after);
}

/**
 * Whether a distribution depends on an asset's value: a specific gift of that asset (without a
 * fixed amount), or any residuary gift. Cancelled distributions don't.
 */
export function distributionDependsOn(distribution: DistributionValues, assetId: string): boolean {
  if (distribution.deletedAt || distribution.status === 'cancelled') return false;
  if (distribution.kind === 'residuary') return true;
  return distribution.kind === 'specific' && distribution.assetId === assetId && distribution.amountCents === undefined;
}

// ---------- the inventory export ----------

export const ESTATE_INVENTORY_TITLE = 'Schedule of assets and liabilities (working draft)';
export const ESTATE_INVENTORY_FOOTER =
  'Working draft prepared from the estate register. This schedule is not a court form and is not the inventory of property filed with an application for a grant.';

export interface InventoryAsset extends AssetValues {
  id: string;
  class: AssetClass;
  description: string;
  institution?: string | undefined;
  valuationSource?: string | undefined;
  valuedOn?: string | undefined;
  jointlyHeld: boolean;
  jointHolding?: JointHolding | undefined;
  status: AssetStatus;
  originalCurrency?: string | undefined;
  originalAmount?: number | undefined;
}

export interface InventoryLiability extends LiabilityValues {
  id: string;
  class: LiabilityClass;
  creditor: string;
  reference?: string | undefined;
  status: LiabilityStatus;
}

export interface InventoryInput {
  matterNumber: string;
  matterTitle: string;
  deceasedName?: string | undefined;
  dateOfDeath?: string | undefined;
  /** Today in the org's time zone. */
  preparedOn: DateOnly | string;
  assets: readonly InventoryAsset[];
  liabilities: readonly InventoryLiability[];
}

export interface InventoryLine {
  description: string;
  reference: string;
  detail: string;
  value: string;
}

export interface InventoryGroup {
  label: string;
  lines: InventoryLine[];
  total: string;
}

/** The schedule as the PDF template (`estate-inventory`) renders it: every value already text. */
export interface InventorySchedule {
  title: string;
  matterNumber: string;
  matterTitle: string;
  deceasedName: string;
  dateOfDeath: string;
  preparedOn: string;
  assetGroups: InventoryGroup[];
  outsideGroups: InventoryGroup[];
  liabilityGroups: InventoryGroup[];
  summary: { label: string; value: string }[];
  outsideNote: string;
  insolvent: boolean;
  insolventNote: string;
  footer: string;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** `2026-10-05` → `5 October 2026` (fixed English, so the export doesn't depend on the locale). */
export function longDate(date: string | undefined): string {
  const match = date ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
  if (!match) return '';
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1] ?? ''} ${match[1]}`;
}

/** Stable order: by description, then id (plain code-unit comparison, the same everywhere). */
const byDescription =
  <T extends { id: string }>(text: (row: T) => string) =>
  (a: T, b: T) =>
    text(a) < text(b) ? -1 : text(a) > text(b) ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function shareText(asset: InventoryAsset): string {
  if (asset.shareBps === undefined || asset.shareBps === SHARE_BPS_WHOLE) return '';
  const pct = asset.shareBps / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2)}% share`;
}

function assetDetail(asset: InventoryAsset): string {
  const parts: string[] = [];
  if (asset.jointlyHeld) parts.push(asset.jointHolding ? JOINT_HOLDING_LABELS[asset.jointHolding] : 'Jointly held');
  const share = shareText(asset);
  if (share) parts.push(`${share} of ${formatCents(cents(asset.valueAtDeathCents))}`);
  if (asset.valuationSource || asset.valuedOn)
    parts.push(
      [
        'Valued',
        asset.valuedOn ? `on ${longDate(asset.valuedOn)}` : '',
        asset.valuationSource ? `(${asset.valuationSource})` : '',
      ]
        .filter(Boolean)
        .join(' '),
    );
  if (asset.originalCurrency && asset.originalAmount !== undefined)
    parts.push(`${asset.originalCurrency} ${asset.originalAmount.toFixed(2)} at the date of death`);
  if (asset.realisedCents !== undefined) parts.push(`Realised ${formatCents(cents(asset.realisedCents))}`);
  return parts.join('; ');
}

function assetGroups(assets: readonly InventoryAsset[]): InventoryGroup[] {
  const order = Object.keys(ASSET_CLASS_LABELS) as AssetClass[];
  return order.flatMap((assetClass) => {
    const rows = assets.filter((asset) => asset.class === assetClass).sort(byDescription((asset) => asset.description));
    if (!rows.length) return [];
    const total = rows.reduce((sum, asset) => sum + assetShareCents(asset), 0);
    return [
      {
        label: ASSET_CLASS_LABELS[assetClass],
        lines: rows.map((asset) => ({
          description: asset.description,
          reference: asset.institution ?? '',
          detail: assetDetail(asset),
          value: formatCents(assetShareCents(asset)),
        })),
        total: formatCents(cents(total)),
      },
    ];
  });
}

function liabilityGroups(liabilities: readonly InventoryLiability[]): InventoryGroup[] {
  const order = Object.keys(LIABILITY_CLASS_LABELS) as LiabilityClass[];
  return order.flatMap((liabilityClass) => {
    const rows = liabilities
      .filter((liability) => liability.class === liabilityClass)
      .sort(byDescription((liability) => liability.creditor));
    if (!rows.length) return [];
    const total = rows.reduce((sum, liability) => sum + liability.amountCents, 0);
    return [
      {
        label: LIABILITY_CLASS_LABELS[liabilityClass],
        lines: rows.map((liability) => ({
          description: liability.creditor,
          reference: liability.reference ?? '',
          detail: LIABILITY_STATUS_LABELS[liability.status],
          value: formatCents(cents(liability.amountCents)),
        })),
        total: formatCents(cents(total)),
      },
    ];
  });
}

/**
 * The inventory schedule (CORE-16): live assets in the estate grouped by class, then assets passing
 * outside it, then liabilities, each group with its total, and the summary. Deterministic: the same
 * register and date give the same schedule.
 */
export function inventorySchedule(input: InventoryInput): InventorySchedule {
  const assets = live(input.assets);
  const liabilities = live(input.liabilities);
  const totals = estateTotals(assets, liabilities);
  return {
    title: ESTATE_INVENTORY_TITLE,
    matterNumber: input.matterNumber,
    matterTitle: input.matterTitle,
    deceasedName: input.deceasedName ?? '',
    dateOfDeath: longDate(input.dateOfDeath),
    preparedOn: longDate(input.preparedOn),
    assetGroups: assetGroups(assets.filter((asset) => !asset.passesOutsideEstate)),
    outsideGroups: assetGroups(assets.filter((asset) => asset.passesOutsideEstate)),
    liabilityGroups: liabilityGroups(liabilities),
    summary: [
      { label: 'Gross estate', value: formatCents(totals.grossCents) },
      { label: 'Liabilities', value: formatCents(totals.liabilitiesCents) },
      { label: 'Net estate', value: formatCents(totals.netCents) },
      { label: 'Assets passing outside the estate', value: formatCents(totals.outsideCents) },
    ],
    outsideNote: OUTSIDE_ESTATE_NOTE,
    insolvent: isInsolvent(totals),
    insolventNote: INSOLVENT_ESTATE_NOTE,
    footer: ESTATE_INVENTORY_FOOTER,
  };
}

/** Dollars without symbols or separators, for spreadsheets: 125000050 → `1250000.50`. */
function csvDollars(amount: number): string {
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * One CSV field: quoted when needed, and text starting with `=`, `+`, `-` or `@` defused with a
 * leading `'` (formula injection). Plain numbers, negative ones included, stay numbers.
 */
function csvField(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) && !/^-?\d+(\.\d+)?$/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const CSV_HEADER = [
  'Section',
  'Class',
  'Description',
  'Institution or reference',
  'Value at date of death (AUD)',
  'Estate share (AUD)',
  'Share',
  'Jointly held',
  'Status',
  'Realised (AUD)',
  'Valuation source',
  'Valued on',
  'Original currency',
  'Original amount',
];

/**
 * The inventory as CSV (RFC 4180, CRLF line ends): one row per asset (in the estate, then outside
 * it) and liability, grouped by class in the schedule's order, a total row per class, then the
 * summary. Amounts are plain dollars. Deterministic, like `inventorySchedule`.
 */
export function inventoryCsv(input: InventoryInput): string {
  const assets = live(input.assets);
  const liabilities = live(input.liabilities);
  const totals = estateTotals(assets, liabilities);
  const rows: string[][] = [CSV_HEADER];
  const blank = (n: number) => Array.from({ length: n }, () => '');
  const assetRows = (section: string, list: InventoryAsset[]) => {
    for (const assetClass of Object.keys(ASSET_CLASS_LABELS) as AssetClass[]) {
      const group = list
        .filter((asset) => asset.class === assetClass)
        .sort(byDescription((asset) => asset.description));
      if (!group.length) continue;
      for (const asset of group) {
        rows.push([
          section,
          ASSET_CLASS_LABELS[assetClass],
          asset.description,
          asset.institution ?? '',
          csvDollars(asset.valueAtDeathCents),
          csvDollars(assetShareCents(asset)),
          shareText(asset),
          asset.jointlyHeld ? (asset.jointHolding ? JOINT_HOLDING_LABELS[asset.jointHolding] : 'Yes') : 'No',
          ASSET_STATUS_LABELS[asset.status],
          asset.realisedCents === undefined ? '' : csvDollars(asset.realisedCents),
          asset.valuationSource ?? '',
          asset.valuedOn ?? '',
          asset.originalCurrency ?? '',
          asset.originalAmount === undefined ? '' : asset.originalAmount.toFixed(2),
        ]);
      }
      const total = group.reduce((sum, asset) => sum + assetShareCents(asset), 0);
      rows.push([section, ASSET_CLASS_LABELS[assetClass], 'Total', '', '', csvDollars(total), ...blank(8)]);
    }
  };
  assetRows(
    'Assets',
    assets.filter((asset) => !asset.passesOutsideEstate),
  );
  assetRows(
    'Passing outside the estate',
    assets.filter((asset) => asset.passesOutsideEstate),
  );
  for (const liabilityClass of Object.keys(LIABILITY_CLASS_LABELS) as LiabilityClass[]) {
    const group = liabilities
      .filter((liability) => liability.class === liabilityClass)
      .sort(byDescription((liability) => liability.creditor));
    if (!group.length) continue;
    for (const liability of group) {
      rows.push([
        'Liabilities',
        LIABILITY_CLASS_LABELS[liabilityClass],
        liability.creditor,
        liability.reference ?? '',
        '',
        csvDollars(liability.amountCents),
        '',
        '',
        LIABILITY_STATUS_LABELS[liability.status],
        ...blank(5),
      ]);
    }
    const total = group.reduce((sum, liability) => sum + liability.amountCents, 0);
    rows.push(['Liabilities', LIABILITY_CLASS_LABELS[liabilityClass], 'Total', '', '', csvDollars(total), ...blank(8)]);
  }
  const summary: [string, number][] = [
    ['Gross estate', totals.grossCents],
    ['Liabilities', totals.liabilitiesCents],
    ['Net estate', totals.netCents],
    ['Assets passing outside the estate', totals.outsideCents],
  ];
  for (const [label, amount] of summary) rows.push(['Summary', '', label, '', '', csvDollars(amount), ...blank(8)]);
  rows.push(['Note', '', ESTATE_INVENTORY_FOOTER, ...blank(11)]);
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}

/** The export's file name: `Schedule of assets and liabilities (working draft) - HV-2026-0001.csv`. */
export function inventoryFileName(matterNumber: string, extension: 'csv' | 'pdf'): string {
  return `${ESTATE_INVENTORY_TITLE} - ${matterNumber.replace(/[\\/:*?"<>|]/g, '-')}.${extension}`;
}

// ---------- callables ----------

/** The `estate-*` callables, as deployed. */
export const ESTATE_CALLABLES = {
  exportInventory: 'estate-exportInventory',
} as const;

/**
 * `estate-exportInventory` (`document.upload`, idempotent, behind `estate.register`): renders the
 * inventory schedule to PDF with the `pdf.render` job (FND-24) and saves it to the matter's
 * documents, privileged when the matter is. Returns the job to watch.
 */
export const ExportInventoryInput = z.strictObject({ requestId: z.uuid(), matterId: DocIdSchema });
export type ExportInventoryInput = z.infer<typeof ExportInventoryInput>;

export interface ExportInventoryResult {
  jobId: string;
}
