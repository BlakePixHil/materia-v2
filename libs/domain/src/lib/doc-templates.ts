import * as z from 'zod';

import { contactDisplayName, formatPhone } from './contacts';
import { longDate } from './estate';
import { FEE_ARRANGEMENT_LABELS } from './fees';
import { formatAbn } from './org-settings';
import { DocIdSchema, NonEmptyString, withMeta } from './schemas/common';
import type { Contact } from './schemas/contacts-matters';
import {
  DocTemplateKindSchema,
  MatterTypeSchema,
  type DocTemplateKind,
  type DocumentCategorySchema,
  type MatterType,
  type PartyRole,
} from './schemas/enums';
import { DOC_TEMPLATE_NAME_MAX } from './schemas/org-records';
import { isDateOnly, type DateOnly } from './values/date-only';
import { formatCents, type Cents } from './values/money';

/**
 * Document templates and docx merge (INT-06, ADR-047): the template kinds, the system templates'
 * names, the merge-field catalogue template authors write against (`{client.fullName}`,
 * `{deceased.dateOfDeath|date}`, `{#executors}{fullName}{/executors}`, `{@body}`), checking a
 * template's tags against it, the formatters, and the merge data built from a matter. The docx
 * itself is filled in Functions (docxtemplater); everything here is pure, so the web app's
 * "Template fields" panel shows exactly what the engine accepts.
 */

// ---------- kinds ----------

export const DOC_TEMPLATE_KINDS = DocTemplateKindSchema.options;

export const DOC_TEMPLATE_KIND_LABELS: Readonly<Record<DocTemplateKind, string>> = {
  letterhead: 'Letterhead',
  letter: 'Letter',
  file_note: 'File note',
  costs_disclosure: 'Costs disclosure',
  chronology: 'Chronology',
  court_book_index: 'Court book index',
  other: 'Other',
};

type DocumentCategory = z.infer<typeof DocumentCategorySchema>;

const KIND_CATEGORY: Readonly<Record<DocTemplateKind, DocumentCategory>> = {
  letterhead: 'correspondence',
  letter: 'correspondence',
  file_note: 'other',
  costs_disclosure: 'correspondence',
  chronology: 'court_document',
  court_book_index: 'court_document',
  other: 'other',
};

/** The category a document generated from a template of this kind is filed under. */
export function docTemplateCategory(kind: DocTemplateKind): DocumentCategory {
  return KIND_CATEGORY[kind];
}

/** The tags a generated document gets: `file-note`, `costs-disclosure` (BILL-06 finds it by this). */
export function docTemplateTags(kind: DocTemplateKind): string[] {
  if (kind === 'file_note') return ['file-note'];
  if (kind === 'costs_disclosure') return ['costs-disclosure'];
  return [];
}

// ---------- system templates ----------

/** A template that ships with Materia (built in Functions, never stored in Firestore). */
export interface SystemDocTemplate {
  id: string;
  name: string;
  kind: DocTemplateKind;
  description: string;
  /** What the person fills in when generating it. */
  inputs: readonly DocTemplateInput[];
}

/** What a template asks for when it's generated: a formatted body (`{@body}`), a recipient. */
export type DocTemplateInput = 'body' | 'recipient';

/** The inputs a template's fields call for. */
export function templateInputs(fields: readonly string[]): DocTemplateInput[] {
  return [
    ...(fields.includes('body') ? (['body'] as const) : []),
    ...(fields.some((field) => field === 'recipient' || field.startsWith('recipient.'))
      ? (['recipient'] as const)
      : []),
  ];
}

/**
 * The system default letterhead and sample templates. Firms download one, change it in Word and
 * upload it as their own ("Replace"), which hides the system one while theirs is published.
 */
export const SYSTEM_DOC_TEMPLATES: readonly SystemDocTemplate[] = [
  {
    id: 'system-letterhead',
    name: 'Letterhead',
    kind: 'letterhead',
    description: 'The firm’s details at the top, a body to type into, and the responsible lawyer’s signature block.',
    inputs: ['body', 'recipient'],
  },
  {
    id: 'system-letter',
    name: 'Letter to client',
    kind: 'letter',
    description: 'A letter to the client on the letterhead, with the matter reference.',
    inputs: ['body'],
  },
  {
    id: 'system-file-note',
    name: 'File note',
    kind: 'file_note',
    description: 'A file note for the matter, filed under the author’s name and today’s date.',
    inputs: ['body'],
  },
  {
    id: 'system-costs-disclosure',
    name: 'Costs disclosure (placeholder)',
    kind: 'costs_disclosure',
    description: 'An illustrative placeholder until the firm uploads its own disclosure. Not practitioner reviewed.',
    inputs: [],
  },
  {
    id: 'system-costs-disclosure-short',
    name: 'Costs disclosure, short form (placeholder)',
    kind: 'costs_disclosure',
    description:
      'An illustrative placeholder for matters whose estimate allows the uniform standard disclosure form (BILL-06). Not practitioner reviewed.',
    inputs: [],
  },
];

export const isSystemDocTemplateId = (id: string): boolean => SYSTEM_DOC_TEMPLATES.some((t) => t.id === id);
export const systemDocTemplate = (id: string): SystemDocTemplate | undefined =>
  SYSTEM_DOC_TEMPLATES.find((t) => t.id === id);

// ---------- the merge-field catalogue ----------

export type MergeFieldType = 'text' | 'date' | 'money' | 'list' | 'block';

export interface MergeField {
  /** The full tag: `client.fullName`; inside a list, the item's own name (`fullName`). */
  tag: string;
  label: string;
  type: MergeFieldType;
  example: string;
  /**
   * Left blank, not reported missing, when there's no value: something a feature supplies
   * (Clerk drafting's body) or that most matters don't have.
   */
  optional?: boolean;
  /** A list's item fields (`{#executors}{fullName}{/executors}`). */
  items?: readonly MergeField[];
}

export interface MergeFieldSection {
  id: string;
  title: string;
  description: string;
  /** The group's own name (`client`), usable as a condition: `{#client.email}…{/client.email}`. */
  prefix?: string;
  fields: readonly MergeField[];
}

const person = (prefix: string, example: { full: string; first: string; last: string }): MergeField[] => {
  const tag = (name: string) => (prefix ? `${prefix}.${name}` : name);
  return [
    { tag: tag('fullName'), label: 'Full name', type: 'text', example: example.full },
    { tag: tag('firstName'), label: 'First name', type: 'text', example: example.first },
    { tag: tag('lastName'), label: 'Last name', type: 'text', example: example.last },
    { tag: tag('email'), label: 'Email', type: 'text', example: `${example.first.toLowerCase()}@example.com` },
    { tag: tag('phone'), label: 'Phone', type: 'text', example: '0412 345 678' },
    {
      tag: tag('address'),
      label: 'Address (on separate lines)',
      type: 'text',
      example: '12 Example Street\nGeelong VIC 3220',
    },
    {
      tag: tag('addressLine'),
      label: 'Address (one line)',
      type: 'text',
      example: '12 Example Street, Geelong VIC 3220',
    },
  ];
};

/** The parties a template can list, by role: `{#executors}…{/executors}` and `{executorNames}`. */
export const PARTY_LISTS: readonly { role: PartyRole; list: string; names: string; label: string }[] = [
  { role: 'client', list: 'clients', names: 'clientNames', label: 'Clients' },
  { role: 'executor', list: 'executors', names: 'executorNames', label: 'Executors' },
  { role: 'administrator', list: 'administrators', names: 'administratorNames', label: 'Administrators' },
  { role: 'beneficiary', list: 'beneficiaries', names: 'beneficiaryNames', label: 'Beneficiaries' },
  { role: 'trustee', list: 'trustees', names: 'trusteeNames', label: 'Trustees' },
  { role: 'attorney', list: 'attorneys', names: 'attorneyNames', label: 'Attorneys' },
  { role: 'guardian', list: 'guardians', names: 'guardianNames', label: 'Guardians' },
  { role: 'plaintiff', list: 'plaintiffs', names: 'plaintiffNames', label: 'Plaintiffs' },
  { role: 'defendant', list: 'defendants', names: 'defendantNames', label: 'Defendants' },
  { role: 'witness', list: 'witnesses', names: 'witnessNames', label: 'Witnesses' },
  {
    role: 'other_side_solicitor',
    list: 'otherSideSolicitors',
    names: 'otherSideSolicitorNames',
    label: 'Other side’s solicitors',
  },
  { role: 'counsel', list: 'counsel', names: 'counselNames', label: 'Counsel' },
  { role: 'interested_person', list: 'interestedPersons', names: 'interestedPersonNames', label: 'Interested persons' },
];

const PARTY_ITEM_FIELDS: readonly MergeField[] = [
  { tag: 'name', label: 'Name (the full name)', type: 'text', example: 'Thomas Doyle' },
  ...person('', { full: 'Thomas Doyle', first: 'Thomas', last: 'Doyle' }),
  { tag: 'share', label: 'Share', type: 'text', example: 'One half', optional: true },
];

export const DOC_MERGE_FIELD_SECTIONS: readonly MergeFieldSection[] = [
  {
    id: 'matter',
    title: 'Matter',
    description: 'The matter the document is generated on.',
    prefix: 'matter',
    fields: [
      { tag: 'matter.number', label: 'Number', type: 'text', example: 'HV-2026-0012' },
      { tag: 'matter.title', label: 'Title', type: 'text', example: 'Estate of Margaret Doyle' },
      { tag: 'matter.type', label: 'Type', type: 'text', example: 'Probate' },
      { tag: 'matter.jurisdiction', label: 'State', type: 'text', example: 'VIC' },
      { tag: 'matter.openedOn', label: 'Opened', type: 'date', example: '3 October 2026' },
      { tag: 'matter.reference', label: 'Other reference', type: 'text', example: '3E-1042', optional: true },
      {
        tag: 'matter.courtFileNo',
        label: 'Court file number',
        type: 'text',
        example: 'S ECI 2026 01234',
        optional: true,
      },
      { tag: 'matter.willDate', label: 'Date of the will', type: 'date', example: '14 March 2019' },
    ],
  },
  {
    id: 'client',
    title: 'Client',
    description:
      'The matter’s first client. Every client is in the Clients list under Parties ({clientNames} for all their names).',
    prefix: 'client',
    fields: person('client', { full: 'Catherine Doyle', first: 'Catherine', last: 'Doyle' }),
  },
  {
    id: 'deceased',
    title: 'Deceased',
    description: 'The deceased on an estate matter.',
    prefix: 'deceased',
    fields: [
      ...person('deceased', { full: 'Margaret Doyle', first: 'Margaret', last: 'Doyle' }).filter(
        (field) => !/\.(email|phone)$/.test(field.tag),
      ),
      { tag: 'deceased.dateOfBirth', label: 'Date of birth', type: 'date', example: '2 March 1944' },
      { tag: 'deceased.dateOfDeath', label: 'Date of death', type: 'date', example: '17 July 2026' },
      { tag: 'deceased.lastAddress', label: 'Last address', type: 'text', example: 'Geelong VIC' },
      { tag: 'deceased.domicile', label: 'Domicile', type: 'text', example: 'Victoria' },
    ],
  },
  {
    id: 'testator',
    title: 'Will-maker',
    description: 'The will-maker on a will or power of attorney matter.',
    prefix: 'testator',
    fields: person('testator', { full: 'Grace Nguyen', first: 'Grace', last: 'Nguyen' }),
  },
  {
    id: 'estate',
    title: 'Estate',
    description: 'From the matter’s key facts and estate register.',
    prefix: 'estate',
    fields: [
      { tag: 'estate.grantType', label: 'Grant', type: 'text', example: 'Probate' },
      { tag: 'estate.grantDate', label: 'Grant date', type: 'date', example: '2 September 2026' },
      { tag: 'estate.grantNo', label: 'Grant number', type: 'text', example: '2026/00123' },
      { tag: 'estate.grossValue', label: 'Gross value', type: 'money', example: '$1,250,000.00' },
      { tag: 'estate.netValue', label: 'Net value', type: 'money', example: '$1,180,000.00' },
    ],
  },
  {
    id: 'parties',
    title: 'Parties',
    description:
      'Each role is a list: write the item’s fields between the list’s tags, for example {#executors}{fullName}, {/executors}. {executorNames} gives every name in one line ("Catherine Doyle and Peter Hale").',
    fields: PARTY_LISTS.flatMap((party): MergeField[] => [
      { tag: party.list, label: party.label, type: 'list', example: '', items: PARTY_ITEM_FIELDS },
      {
        tag: party.names,
        label: `${party.label}: every name`,
        type: 'text',
        example: 'Catherine Doyle and Peter Hale',
      },
    ]),
  },
  {
    id: 'fee',
    title: 'Fees',
    description: 'The matter’s fee arrangement and estimate.',
    prefix: 'fee',
    fields: [
      { tag: 'fee.arrangement', label: 'Arrangement', type: 'text', example: 'Fixed fee' },
      { tag: 'fee.amount', label: 'Fixed fee', type: 'money', example: '$4,400.00' },
      { tag: 'fee.cap', label: 'Fee cap', type: 'money', example: '$8,000.00' },
      { tag: 'fee.hourlyRate', label: 'Hourly rate', type: 'money', example: '$450.00' },
      { tag: 'fee.estimate', label: 'Estimate', type: 'money', example: '$6,000.00' },
      { tag: 'fee.estimateLow', label: 'Estimate, low', type: 'money', example: '$4,000.00' },
      { tag: 'fee.estimateHigh', label: 'Estimate, high', type: 'money', example: '$8,000.00' },
    ],
  },
  {
    id: 'disclosure',
    title: 'Costs disclosure',
    description:
      'Filled in when a costs disclosure is generated from the matter’s Costs disclosure card. {#disclosure.updated}…{/disclosure.updated} shows only on an updated disclosure.',
    prefix: 'disclosure',
    fields: [
      {
        tag: 'disclosure.form',
        label: 'Form',
        type: 'text',
        example: 'Short form (uniform standard disclosure form)',
        optional: true,
      },
      { tag: 'disclosure.estimate', label: 'Estimate disclosed', type: 'money', example: '$6,000.00', optional: true },
      {
        tag: 'disclosure.updated',
        label: 'An updated disclosure (a condition)',
        type: 'text',
        example: 'Updated',
        optional: true,
      },
      {
        tag: 'disclosure.previousEstimate',
        label: 'Estimate disclosed before',
        type: 'money',
        example: '$4,000.00',
        optional: true,
      },
      {
        tag: 'disclosure.citation',
        label: 'Rule',
        type: 'text',
        example: 'Legal Profession Uniform Law s 174',
        optional: true,
      },
    ],
  },
  {
    id: 'firm',
    title: 'Firm',
    description: 'From Practice details and the letterhead details on this page.',
    prefix: 'firm',
    fields: [
      { tag: 'firm.name', label: 'Name', type: 'text', example: 'Harbour & Vine Legal' },
      { tag: 'firm.abn', label: 'ABN', type: 'text', example: '51 824 753 556' },
      {
        tag: 'firm.address',
        label: 'Address (on separate lines)',
        type: 'text',
        example: 'Level 2, 10 Example Street\nGeelong VIC 3220',
      },
      {
        tag: 'firm.addressLine',
        label: 'Address (one line)',
        type: 'text',
        example: 'Level 2, 10 Example Street, Geelong VIC 3220',
      },
      { tag: 'firm.phone', label: 'Phone', type: 'text', example: '(03) 5200 0000' },
      { tag: 'firm.email', label: 'Email', type: 'text', example: 'reception@harbourvine.example' },
      { tag: 'firm.website', label: 'Website', type: 'text', example: 'harbourvine.example', optional: true },
      {
        tag: 'firm.footer',
        label: 'Footer note',
        type: 'text',
        example: 'Liability limited by a scheme…',
        optional: true,
      },
    ],
  },
  {
    id: 'lawyer',
    title: 'Responsible lawyer',
    description: 'The lawyer responsible for the matter, for the signature block.',
    prefix: 'lawyer',
    fields: [
      { tag: 'lawyer.fullName', label: 'Name', type: 'text', example: 'Jordan Price' },
      { tag: 'lawyer.title', label: 'Title', type: 'text', example: 'Senior Associate' },
      { tag: 'lawyer.email', label: 'Email', type: 'text', example: 'jordan@harbourvine.example' },
    ],
  },
  {
    id: 'author',
    title: 'Author',
    description: 'The person generating the document.',
    prefix: 'author',
    fields: [
      { tag: 'author.fullName', label: 'Name', type: 'text', example: 'Daniel Kim' },
      { tag: 'author.title', label: 'Title', type: 'text', example: 'Paralegal' },
      { tag: 'author.email', label: 'Email', type: 'text', example: 'daniel@harbourvine.example' },
    ],
  },
  {
    id: 'date',
    title: 'Date',
    description: 'Today in the firm’s time zone.',
    fields: [{ tag: 'today', label: 'Today', type: 'date', example: '3 October 2026' }],
  },
  {
    id: 'supplied',
    title: 'Filled in when generating',
    description:
      'Left blank unless the person or feature generating the document supplies them, as Clerk drafting does. {@body} must be on a paragraph of its own.',
    prefix: 'recipient',
    fields: [
      { tag: 'body', label: 'Body (formatted text)', type: 'block', example: '', optional: true },
      { tag: 'recipient.name', label: 'Recipient’s name', type: 'text', example: 'Thomas Doyle', optional: true },
      {
        tag: 'recipient.address',
        label: 'Recipient’s address',
        type: 'text',
        example: '14 Example Street\nGeelong VIC 3220',
        optional: true,
      },
    ],
  },
];

/** Every field by its full tag, plus each group's prefix (a condition such as `{#client.email}`). */
const ROOT_FIELDS: ReadonlyMap<string, MergeField> = new Map(
  DOC_MERGE_FIELD_SECTIONS.flatMap((section) => section.fields.map((field) => [field.tag, field] as const)),
);
const GROUPS: ReadonlySet<string> = new Set(
  DOC_MERGE_FIELD_SECTIONS.flatMap((section) => (section.prefix ? [section.prefix] : [])),
);

// ---------- tags ----------

/** The formatters a tag can use after a pipe: `{deceased.dateOfDeath|date}`. */
export const MERGE_FILTERS = ['date', 'money', 'upper', 'lower'] as const;
export type MergeFilter = (typeof MERGE_FILTERS)[number];

const PATH = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/;

export type ParsedMergeTag = { path: string; filters: string[] };

/** `deceased.dateOfDeath | date` → `{path: 'deceased.dateOfDeath', filters: ['date']}`. */
export function parseMergeTag(raw: string): ParsedMergeTag {
  const [path = '', ...filters] = raw.split('|').map((part) => part.trim());
  return { path, filters };
}

/** A tag resolved against the catalogue: its full path (`executors.fullName`) and field, if known. */
export interface ResolvedMergeTag {
  path: string;
  field?: MergeField;
  /** A group's name (`client`), which only works as a condition. */
  group?: boolean;
}

/**
 * Resolves a tag's path where it stands: inside `{#executors}` a bare `fullName` is the executor's;
 * inside `{#recipient}`, `name` is `recipient.name`; anything else is looked up from the top, as the
 * engine does.
 */
export function resolveMergeTag(path: string, scope: readonly string[] = []): ResolvedMergeTag {
  for (let i = scope.length - 1; i >= 0; i--) {
    const outer = parseMergeTag(scope[i] ?? '').path;
    const list = ROOT_FIELDS.get(outer);
    const item = list?.type === 'list' ? list.items?.find((field) => field.tag === path) : undefined;
    if (item) return { path: `${outer}.${path}`, field: item };
    const nested = GROUPS.has(outer) ? ROOT_FIELDS.get(`${outer}.${path}`) : undefined;
    if (nested) return { path: `${outer}.${path}`, field: nested };
  }
  const field = ROOT_FIELDS.get(path);
  if (field) return { path, field };
  if (GROUPS.has(path)) return { path, group: true };
  return { path };
}

/** One tag in a template as the engine parsed it: plain, a loop or condition, or a raw block. */
export interface TemplateTag {
  value: string;
  kind: 'value' | 'section' | 'block';
  /** The loops and conditions it sits inside, outermost first. */
  scope: readonly string[];
}

export interface DocTemplateProblem {
  tag: string;
  code: 'syntax' | 'unknown_field' | 'unknown_filter' | 'not_a_value' | 'not_a_block' | 'not_a_list';
  message: string;
}

/** A known tag that differs only in case (`client.fullname` → `client.fullName`). */
function suggestion(path: string, scope: readonly string[]): string | undefined {
  const lower = path.toLowerCase();
  const candidates = [
    ...ROOT_FIELDS.keys(),
    ...scope.flatMap((outer) => ROOT_FIELDS.get(outer)?.items?.map((item) => item.tag) ?? []),
  ];
  return candidates.find((candidate) => candidate.toLowerCase() === lower);
}

/** The tag as the author wrote it, for messages: `{client.fullName}`, `{#executors}`, `{@body}`. */
export function displayTag(tag: Pick<TemplateTag, 'value' | 'kind'>): string {
  return `{${tag.kind === 'section' ? '#' : tag.kind === 'block' ? '@' : ''}${tag.value}}`;
}

/**
 * Checks a template's tags against the catalogue. Every problem names the tag: an unknown field
 * (with the right spelling when only the case is wrong), an unknown formatter, a list or group used
 * as a value, or a value used as `{@…}`.
 */
export function checkMergeTags(tags: readonly TemplateTag[]): DocTemplateProblem[] {
  const problems: DocTemplateProblem[] = [];
  for (const tag of tags) {
    const shown = displayTag(tag);
    const { path, filters } = parseMergeTag(tag.value);
    if (!PATH.test(path)) {
      problems.push({
        tag: shown,
        code: 'syntax',
        message: `${shown} isn’t a field name. Use letters and dots, like {client.fullName}.`,
      });
      continue;
    }
    const unknownFilter = filters.find((filter) => !(MERGE_FILTERS as readonly string[]).includes(filter));
    if (unknownFilter !== undefined) {
      problems.push({
        tag: shown,
        code: 'unknown_filter',
        message: `${shown} uses “${unknownFilter}”, which isn’t a formatter. Use ${MERGE_FILTERS.join(', ')}.`,
      });
      continue;
    }
    const resolved = resolveMergeTag(path, tag.scope);
    if (!resolved.field && !resolved.group) {
      const better = suggestion(path, tag.scope);
      problems.push({
        tag: shown,
        code: 'unknown_field',
        message: better
          ? `${shown} isn’t a field. Did you mean {${better}}?`
          : `${shown} isn’t a field. See Template fields for the ones you can use.`,
      });
      continue;
    }
    if (tag.kind === 'section') continue;
    if (tag.kind === 'block') {
      if (resolved.field?.type !== 'block') {
        problems.push({
          tag: shown,
          code: 'not_a_block',
          message: `${shown}: only {@body} can be a formatted block. Use {${path}}.`,
        });
      }
      continue;
    }
    if (resolved.group) {
      problems.push({
        tag: shown,
        code: 'not_a_value',
        message: `${shown} is a group of fields. Use one of them, like {${path}.${path === 'recipient' ? 'name' : 'fullName'}}.`,
      });
    } else if (resolved.field?.type === 'list') {
      problems.push({
        tag: shown,
        code: 'not_a_list',
        message: `${shown} is a list. Write {#${path}}{fullName}{/${path}}.`,
      });
    } else if (resolved.field?.type === 'block') {
      problems.push({
        tag: shown,
        code: 'not_a_block',
        message: `${shown} is a formatted block. Write {@${path}} on a paragraph of its own.`,
      });
    }
  }
  return problems;
}

/** The full paths of the fields a template uses (lists and groups included), sorted and unique. */
export function templateFields(tags: readonly TemplateTag[]): string[] {
  const paths = tags.map((tag) => resolveMergeTag(parseMergeTag(tag.value).path, tag.scope).path);
  return [...new Set(paths)].sort();
}

// ---------- values and formatters ----------

/** The value at a dotted path, or undefined. */
export function valueAt(scope: unknown, path: string): unknown {
  let value: unknown = scope;
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** No value: undefined, null, an empty or blank string, or an empty list. */
export function isBlankValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** Applies one formatter: `date` (`3 October 2026`), `money` (cents → `$1,234.56`), `upper`, `lower`. */
export function applyMergeFilter(value: unknown, filter: MergeFilter): unknown {
  switch (filter) {
    case 'date':
      return typeof value === 'string' && isDateOnly(value) ? longDate(value) : value;
    case 'money':
      return typeof value === 'number' && Number.isFinite(value) ? formatCents(Math.round(value) as Cents) : value;
    case 'upper':
      return typeof value === 'string' ? value.toLocaleUpperCase('en-AU') : value;
    case 'lower':
      return typeof value === 'string' ? value.toLocaleLowerCase('en-AU') : value;
  }
}

/**
 * The text a value tag prints: dates and money format themselves (a `date` field prints
 * `3 October 2026` with or without `|date`), then the tag's formatters run in order.
 */
export function formatMergeValue(value: unknown, field: MergeField | undefined, filters: readonly string[]): unknown {
  let result = value;
  const explicit = filters.includes('date') || filters.includes('money');
  if (!explicit && field?.type === 'date') result = applyMergeFilter(result, 'date');
  if (!explicit && field?.type === 'money') result = applyMergeFilter(result, 'money');
  for (const filter of filters) {
    if ((MERGE_FILTERS as readonly string[]).includes(filter)) result = applyMergeFilter(result, filter as MergeFilter);
  }
  return result;
}

/** How a missing field prints, so it can't go out unnoticed: `[[missing: client.address]]`. */
export const missingMarker = (path: string) => `[[missing: ${path}]]`;

// ---------- the letterhead details ----------

export const LETTERHEAD_DOC = 'letterhead';

/** The firm's contact details for the letterhead (INT-06); the name and ABN come from Practice details. */
export const LetterheadDetailsSchema = z
  .object({
    address: z.string().trim().max(300).optional(),
    phone: z.string().trim().max(40).optional(),
    email: z.string().trim().max(120).optional(),
    website: z.string().trim().max(200).optional(),
    /** A line at the foot of every page ("Liability limited by a scheme approved under…"). */
    footer: z.string().trim().max(300).optional(),
  })
  .strict();
export type LetterheadDetails = z.infer<typeof LetterheadDetailsSchema>;

/** `orgs/{orgId}/settings/letterhead`: every member reads it; `docs-saveLetterhead` writes it. */
export const LetterheadDoc = {
  ...withMeta(
    { ...LetterheadDetailsSchema.shape },
    { path: 'orgs/{orgId}/settings', migratable: false, updatable: [] },
  ),
  /** Its one document id, so the seed tells it apart from the other settings documents. */
  docId: LETTERHEAD_DOC,
};
export const letterheadPath = (orgId: string) => `orgs/${orgId}/settings/${LETTERHEAD_DOC}`;

// ---------- merge data ----------

/** Formal names of the matter types, for documents ("Letters of administration", not "Letters of admin"). */
export const DOC_MATTER_TYPE_NAMES: Readonly<Record<MatterType, string>> = {
  will: 'Will',
  poa: 'Power of attorney',
  probate: 'Probate',
  loa: 'Letters of administration',
  admin: 'Estate administration',
  fp: 'Family provision claim',
  contest: 'Will dispute',
  trust: 'Testamentary trust',
};

const GRANT_NAMES: Readonly<Record<string, string>> = {
  probate: 'Probate',
  loa: 'Letters of administration',
  loa_with_will: 'Letters of administration with the will annexed',
  reseal: 'Reseal',
};

type ContactLike = Partial<
  Pick<
    Contact,
    | 'kind'
    | 'givenNames'
    | 'familyName'
    | 'preferredName'
    | 'orgName'
    | 'dateOfBirth'
    | 'emails'
    | 'phones'
    | 'addresses'
  >
>;
type AddressLike = NonNullable<ContactLike['addresses']>[number];

export interface MergeMember {
  displayName: string;
  title?: string;
  email?: string;
  defaultRateCents?: number;
}

/** What the merge data is built from: the records `docs-generate` reads. */
export interface MergeSources {
  org: { name: string; abn?: string };
  letterhead?: LetterheadDetails;
  matter: {
    number: string;
    title: string;
    type: MatterType;
    jurisdiction: string;
    openedOn?: DateOnly;
    externalRef?: string;
    deceased?: { contactId: string; dateOfDeath?: string; domicile?: string; lastAddress?: string };
    testator?: { contactId: string };
    clientContactIds: readonly string[];
    fee?: {
      arrangement?: string;
      amountCents?: number;
      capCents?: number;
      estimateCents?: number;
      estimateLowCents?: number;
      estimateHighCents?: number;
      rateOverrideCents?: number;
    };
    estate?: {
      grossValueCents?: number;
      netValueCents?: number;
      grantType?: string;
      grantDate?: string;
      grantNo?: string;
    };
    facts?: { willDate?: string; courtFileNo?: string };
  };
  /** Contacts by id: the clients, deceased, testator and every party. */
  contacts: Readonly<Record<string, ContactLike>>;
  /** The matter's live parties. */
  parties: readonly { contactId: string; role: PartyRole; share?: string }[];
  lawyer?: MergeMember;
  author?: MergeMember;
  today: DateOnly;
}

const STATE_NAMES: Readonly<Record<string, string>> = {
  VIC: 'Victoria',
  NSW: 'New South Wales',
  QLD: 'Queensland',
  WA: 'Western Australia',
  SA: 'South Australia',
  TAS: 'Tasmania',
  ACT: 'Australian Capital Territory',
  NT: 'Northern Territory',
};

const text = (value: string | undefined) => (value && value.trim() ? value.trim() : undefined);

/** `A`, `A and B`, `A, B and C`. */
export function joinNames(names: readonly string[]): string | undefined {
  if (names.length === 0) return undefined;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function preferredAddress(contact: ContactLike): AddressLike | undefined {
  const addresses = contact.addresses ?? [];
  return addresses.find((a) => a.type === 'postal') ?? addresses.find((a) => a.type === 'residential') ?? addresses[0];
}

const addressLines = (address: AddressLike) =>
  [address.line1, address.line2, `${address.suburb} ${address.state} ${address.postcode}`].filter(
    (line): line is string => !!line && line.trim() !== '',
  );

/** A contact's person fields: names, first email and phone, preferred (postal) address. */
export function personFields(contact: ContactLike | undefined): Record<string, string | undefined> | undefined {
  if (!contact) return undefined;
  const organisation = contact.kind === 'organisation';
  const address = preferredAddress(contact);
  const phone = contact.phones?.[0]?.number;
  return {
    fullName: contactDisplayName(contact),
    firstName: organisation ? undefined : (text(contact.preferredName) ?? text(contact.givenNames)?.split(/\s+/)[0]),
    lastName: organisation ? undefined : text(contact.familyName),
    email: contact.emails?.[0]?.address,
    phone: phone ? formatPhone(phone) : undefined,
    address: address ? addressLines(address).join('\n') : undefined,
    addressLine: address ? addressLines(address).join(', ') : undefined,
  };
}

const member = (m: MergeMember | undefined) =>
  m ? { fullName: text(m.displayName), title: text(m.title), email: text(m.email) } : undefined;

/**
 * The merge data for a matter (INT-06): plain values the templates' tags read. Dates stay
 * `YYYY-MM-DD` and money stays cents, so the formatters see the real values; anything unknown is
 * left out, so the engine reports it missing.
 */
export function buildMergeData(sources: MergeSources): Record<string, unknown> {
  const { matter, contacts, letterhead } = sources;
  const live = (id: string) => contacts[id];
  const clients = matter.clientContactIds.map(live).filter((c): c is ContactLike => !!c);
  const deceasedContact = matter.deceased ? live(matter.deceased.contactId) : undefined;
  const fee = matter.fee ?? {};
  const firmAddress = text(letterhead?.address)
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const data: Record<string, unknown> = {
    matter: {
      number: matter.number,
      title: matter.title,
      type: DOC_MATTER_TYPE_NAMES[matter.type],
      jurisdiction: matter.jurisdiction,
      openedOn: matter.openedOn,
      reference: text(matter.externalRef),
      courtFileNo: text(matter.facts?.courtFileNo),
      willDate: matter.facts?.willDate,
    },
    client: personFields(clients[0]),
    deceased: matter.deceased
      ? {
          ...personFields(deceasedContact),
          email: undefined,
          phone: undefined,
          dateOfBirth: deceasedContact?.dateOfBirth,
          dateOfDeath: matter.deceased.dateOfDeath,
          lastAddress: text(matter.deceased.lastAddress),
          domicile: text(STATE_NAMES[matter.deceased.domicile ?? ''] ?? matter.deceased.domicile),
        }
      : undefined,
    testator: matter.testator ? personFields(live(matter.testator.contactId)) : undefined,
    estate: {
      grantType: matter.estate?.grantType ? GRANT_NAMES[matter.estate.grantType] : undefined,
      grantDate: matter.estate?.grantDate,
      grantNo: text(matter.estate?.grantNo),
      grossValue: matter.estate?.grossValueCents,
      netValue: matter.estate?.netValueCents,
    },
    fee: {
      arrangement: fee.arrangement
        ? FEE_ARRANGEMENT_LABELS[fee.arrangement as keyof typeof FEE_ARRANGEMENT_LABELS]
        : undefined,
      amount: fee.amountCents,
      cap: fee.capCents,
      // A fixed fee or pro bono matter isn't charged by the hour unless it has its own rate.
      hourlyRate:
        fee.rateOverrideCents ??
        (fee.arrangement === 'fixed' || fee.arrangement === 'pro_bono' ? undefined : sources.lawyer?.defaultRateCents),
      estimate: fee.estimateCents,
      estimateLow: fee.estimateLowCents,
      estimateHigh: fee.estimateHighCents,
    },
    firm: {
      name: text(sources.org.name),
      abn: sources.org.abn ? formatAbn(sources.org.abn) : undefined,
      address: firmAddress?.join('\n'),
      addressLine: firmAddress?.join(', '),
      phone: text(letterhead?.phone),
      email: text(letterhead?.email),
      website: text(letterhead?.website),
      footer: text(letterhead?.footer),
    },
    lawyer: member(sources.lawyer),
    author: member(sources.author),
    today: sources.today,
  };

  for (const party of PARTY_LISTS) {
    const rows: Record<string, string | undefined>[] = sources.parties
      .filter((p) => p.role === party.role)
      .map((p) => ({ contact: live(p.contactId), share: text(p.share) }))
      .filter((row): row is { contact: ContactLike; share: string | undefined } => !!row.contact)
      .map((row) => ({ ...listItem(row.contact), share: row.share }));
    // The clients list follows the matter's clients when the party rows haven't caught up.
    const list = party.role === 'client' && rows.length === 0 ? clients.map(listItem) : rows;
    data[party.list] = list;
    data[party.names] = joinNames(list.map((row) => row['fullName']).filter((n): n is string => !!n));
  }
  return data;
}

/** A list row: the person fields, with `{name}` as the full name (`{#beneficiaries}{name}{/beneficiaries}`). */
function listItem(contact: ContactLike): Record<string, string | undefined> {
  const fields = personFields(contact);
  return { name: fields?.['fullName'], ...fields };
}

// ---------- callables ----------

const RequestId = z.uuid();

/** The `docs-*` callables (INT-06), as deployed. */
export const DOC_CALLABLES = {
  generate: 'docs-generate',
  saveTemplate: 'docs-saveTemplate',
  publishTemplate: 'docs-publishTemplate',
  unpublishTemplate: 'docs-unpublishTemplate',
  deleteTemplate: 'docs-deleteTemplate',
  previewTemplate: 'docs-previewTemplate',
  downloadTemplate: 'docs-downloadTemplate',
  saveLetterhead: 'docs-saveLetterhead',
} as const;

/** The longest Markdown body a caller can supply (`data.body`). */
export const DOC_BODY_MAX = 50_000;

/** What a person (or feature) can fill in when generating: a formatted body and a recipient. */
export const GenerateDataSchema = z
  .object({
    body: z.string().max(DOC_BODY_MAX).optional(),
    recipient: z
      .object({ name: z.string().trim().max(200).optional(), address: z.string().trim().max(500).optional() })
      .strict()
      .optional(),
  })
  .strict();
export type GenerateData = z.infer<typeof GenerateDataSchema>;

/**
 * `docs-generate` (`document.upload`, idempotent): merges a published org template (or a system
 * template) with the matter's data and saves the result to the matter's documents
 * (`source: 'generated'`, the kind's category and tags). Missing fields print
 * `[[missing: …]]` and are listed in the result.
 */
export const GenerateDocumentInput = z.object({
  requestId: RequestId,
  templateId: DocIdSchema,
  matterId: DocIdSchema,
  data: GenerateDataSchema.optional(),
  /** The document's name; defaults to the template's name and today's date. */
  name: NonEmptyString.max(200).optional(),
  /** File it as privileged (it always is on a privileged matter). Needs `privileged.view`. */
  privileged: z.boolean().optional(),
});
export type GenerateDocumentInput = z.infer<typeof GenerateDocumentInput>;

export interface GenerateDocumentResult {
  documentId: string;
  name: string;
  /** Fields with no value, as full paths (`client.address`), in the order they appear. */
  missing: string[];
  warnings: string[];
}

/**
 * `docs-saveTemplate` (`org.settings`, idempotent): creates a template, or with `templateId`
 * changes its name, kind and matter types and, with a file, adds a version. The file must be a
 * .docx (base64, up to 5 MB) whose tags all check out; otherwise INVALID_ARGUMENT with
 * `details.reason: 'template_invalid'` and `details.problems` (each naming its tag).
 */
export const SaveDocTemplateInput = z
  .object({
    requestId: RequestId,
    templateId: DocIdSchema.optional(),
    name: NonEmptyString.max(DOC_TEMPLATE_NAME_MAX),
    kind: DocTemplateKindSchema,
    matterTypes: z.array(MatterTypeSchema).max(MatterTypeSchema.options.length).optional(),
    /** The built-in template it replaces while published; null stops replacing one. */
    replaces: DocIdSchema.refine(isSystemDocTemplateId, { message: 'Not a system template' }).nullable().optional(),
    file: z
      .object({
        fileName: NonEmptyString.max(255).regex(/\.docx$/i, { message: 'Upload a .docx file' }),
        contentBase64: z
          .string()
          .min(1)
          .max(Math.ceil((5 * 1024 * 1024 * 4) / 3) + 4),
      })
      .optional(),
  })
  .refine((input) => !!input.templateId || !!input.file, { message: 'A new template needs a file', path: ['file'] });
export type SaveDocTemplateInput = z.infer<typeof SaveDocTemplateInput>;

export interface SaveDocTemplateResult {
  templateId: string;
  version: number;
  fields: string[];
  warnings: string[];
}

/** `docs-publishTemplate` (`org.settings`, idempotent): documents are generated from `version` from now on. */
export const PublishDocTemplateInput = z.object({
  requestId: RequestId,
  templateId: DocIdSchema,
  version: z.number().int().min(1),
});
export type PublishDocTemplateInput = z.infer<typeof PublishDocTemplateInput>;

/** `docs-unpublishTemplate` and `docs-deleteTemplate` (`org.settings`, idempotent). */
export const DocTemplateRefInput = z.object({ requestId: RequestId, templateId: DocIdSchema });
export type DocTemplateRefInput = z.infer<typeof DocTemplateRefInput>;

export interface DocTemplateResult {
  templateId: string;
}

/**
 * `docs-previewTemplate` (`org.settings`): a test merge against a matter, saving nothing. Returns
 * the merged document as HTML (the body; the letterhead's header and footer aren't shown), the
 * missing fields and warnings, and the merged .docx (base64) to download.
 */
export const PreviewDocTemplateInput = z.object({
  templateId: DocIdSchema,
  version: z.number().int().min(1).optional(),
  matterId: DocIdSchema,
  data: GenerateDataSchema.optional(),
});
export type PreviewDocTemplateInput = z.infer<typeof PreviewDocTemplateInput>;

export interface PreviewDocTemplateResult {
  html: string;
  missing: string[];
  warnings: string[];
  fileName: string;
  contentBase64: string;
}

/** `docs-downloadTemplate` (`org.settings`): a template's file (a system one too, as a starting point). */
export const DownloadDocTemplateInput = z.object({
  templateId: DocIdSchema,
  version: z.number().int().min(1).optional(),
});
export type DownloadDocTemplateInput = z.infer<typeof DownloadDocTemplateInput>;

export interface DownloadDocTemplateResult {
  fileName: string;
  contentBase64: string;
}

/** `docs-saveLetterhead` (`org.settings`, idempotent): replaces the letterhead details. */
export const SaveLetterheadInput = LetterheadDetailsSchema.extend({ requestId: RequestId });
export type SaveLetterheadInput = z.infer<typeof SaveLetterheadInput>;

/**
 * The templates a matter's "New from template" offers: the org's published ones for its type, then
 * the system ones, less any that one of those replaces.
 */
export function offeredDocTemplates<
  T extends {
    id: string;
    published: boolean;
    matterTypes: readonly MatterType[];
    replaces?: string | undefined;
    deletedAt?: unknown;
  },
>(orgTemplates: readonly T[], matterType: MatterType): { org: T[]; system: SystemDocTemplate[] } {
  const org = orgTemplates.filter(
    (t) => t.published && !t.deletedAt && (t.matterTypes.length === 0 || t.matterTypes.includes(matterType)),
  );
  const replaced = new Set(org.flatMap((t) => (t.replaces ? [t.replaces] : [])));
  return { org, system: SYSTEM_DOC_TEMPLATES.filter((t) => !replaced.has(t.id)) };
}
