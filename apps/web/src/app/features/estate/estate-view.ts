import type { EstateAsset, EstateDistribution, EstateLiability, WithId } from '@materia/data-access/repository';
import {
  ASSET_CLASS_LABELS,
  ASSET_STATUS_LABELS,
  cents,
  DISTRIBUTION_KIND_LABELS,
  DISTRIBUTION_STATUS_LABELS,
  distributionCents,
  formatCents,
  JOINT_HOLDING_LABELS,
  LIABILITY_CLASS_LABELS,
  LIABILITY_STATUS_LABELS,
  SHARE_BPS_WHOLE,
  type AssetClass,
  type AssetStatus,
  type DistributionKind,
  type DistributionStatus,
  type InventoryAsset,
  type InventoryLiability,
  type JointHolding,
  type LiabilityClass,
  type LiabilityStatus,
} from '@materia/domain';

/**
 * The Estate tab's words and parsing (CORE-16). The maths (totals, residue, the inventory) lives in
 * `libs/domain/src/lib/estate.ts`, shared with `estate-onWrite` and the PDF export.
 */

export type AssetRow = WithId<EstateAsset>;
export type LiabilityRow = WithId<EstateLiability>;
export type DistributionRow = WithId<EstateDistribution>;

const options = <K extends string>(labels: Record<K, string>) =>
  (Object.keys(labels) as K[]).map((value) => ({ value, label: labels[value] }));

export const ASSET_CLASS_OPTIONS = options<AssetClass>(ASSET_CLASS_LABELS);
export const ASSET_STATUS_OPTIONS = options<AssetStatus>(ASSET_STATUS_LABELS);
export const JOINT_HOLDING_OPTIONS = options<JointHolding>(JOINT_HOLDING_LABELS);
export const LIABILITY_CLASS_OPTIONS = options<LiabilityClass>(LIABILITY_CLASS_LABELS);
export const LIABILITY_STATUS_OPTIONS = options<LiabilityStatus>(LIABILITY_STATUS_LABELS);
export const DISTRIBUTION_KIND_OPTIONS = options<DistributionKind>(DISTRIBUTION_KIND_LABELS);
export const DISTRIBUTION_STATUS_OPTIONS = options<DistributionStatus>(DISTRIBUTION_STATUS_LABELS);

export const money = (amount: number | undefined): string => (amount === undefined ? '' : formatCents(cents(amount)));

/** An amount typed in dollars ("1,250,000.50", "$420") as cents; `undefined` for blank. */
export function parseMoneyInput(text: string): { value: number | undefined } | { error: string } {
  const amount = text.trim().replace(/[$,\s]/g, '');
  if (!amount) return { value: undefined };
  if (!/^\d+(\.\d{1,2})?$/.test(amount)) return { error: 'Enter an amount like 1,250,000.00.' };
  const [dollars = '0', part = ''] = amount.split('.');
  return { value: Number(dollars) * 100 + Number(part.padEnd(2, '0')) };
}

/** Cents as the money fields show them for editing: `125000050` → `1250000.50`. */
export function moneyInput(amount: number | undefined): string {
  if (amount === undefined) return '';
  return `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, '0')}`;
}

/** A share typed as a percentage ("50", "33.33%") in basis points (1 to 10,000). */
export function parseShareInput(text: string): { value: number | undefined } | { error: string } {
  const trimmed = text.trim().replace(/%$/, '').trim();
  if (!trimmed) return { value: undefined };
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return { error: 'Enter a percentage like 50 or 33.33.' };
  const bps = Math.round(Number(trimmed) * 100);
  return bps >= 1 && bps <= SHARE_BPS_WHOLE ? { value: bps } : { error: 'Enter a share between 0.01% and 100%.' };
}

export function shareInput(bps: number | undefined): string {
  return bps === undefined ? '' : String(bps / 100);
}

/** An asset's extra facts for its row: joint holding, share, outside the estate, foreign currency. */
export function assetFlags(asset: EstateAsset): string {
  const parts: string[] = [];
  if (asset.passesOutsideEstate) parts.push('Outside the estate');
  if (asset.jointlyHeld) parts.push(asset.jointHolding ? JOINT_HOLDING_LABELS[asset.jointHolding] : 'Jointly held');
  if (asset.shareBps !== undefined && asset.shareBps !== SHARE_BPS_WHOLE) parts.push(`${asset.shareBps / 100}% share`);
  if (asset.originalCurrency && asset.originalAmount !== undefined)
    parts.push(`${asset.originalCurrency} ${asset.originalAmount.toFixed(2)}`);
  if (asset.documentIds.length)
    parts.push(`${asset.documentIds.length} valuation document${asset.documentIds.length === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** What a distribution gives, in words: "$20,000.00", "Holden Astra ($8,500.00)", "One half of the residue". */
export function distributionGift(distribution: EstateDistribution, assets: ReadonlyMap<string, EstateAsset>): string {
  if (distribution.kind === 'residuary') return distribution.share ? `${distribution.share} of the residue` : 'Residue';
  const asset = distribution.assetId ? assets.get(distribution.assetId) : undefined;
  const value = money(distributionCents(distribution, assets));
  if (distribution.kind === 'specific')
    return asset ? `${asset.description} (${value})` : distribution.assetId ? `Removed asset (${value})` : value;
  return value;
}

/** The register as the inventory builders read it. */
export const inventoryAssets = (rows: readonly AssetRow[]): InventoryAsset[] => rows.map((row) => ({ ...row }));
export const inventoryLiabilities = (rows: readonly LiabilityRow[]): InventoryLiability[] =>
  rows.map((row) => ({ ...row }));

/** Copy for an estate write the rules or the network refused. */
export const ESTATE_SAVE_FAILED = 'The estate register didn’t save';
