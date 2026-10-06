import type { AuditReport, NumberRange } from './report.ts';
import type { HtmlStats } from '../legacy/html.ts';

/** `audit-report.md`: the JSON report for people. Same content, no more (counts and shapes only). */

const cell = (value: unknown) =>
  String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');

function table(head: string[], rows: unknown[][]): string {
  if (!rows.length) return '_None._';
  return [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n');
}

function counts(record: Record<string, number>): string {
  const entries = Object.entries(record);
  return entries.length ? entries.map(([key, n]) => `${key} × ${n}`).join(', ') : '—';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function range(r: NumberRange): string {
  if (!r.count) return r.nonNumeric ? `no numbers (${r.nonNumeric} non-numeric)` : '—';
  return `${r.count} ${r.count === 1 ? 'value' : 'values'}, min ${r.min}, median ${r.median}, max ${r.max}; ${r.zero} zero, ${r.decimals} with decimals, ${r.negative} negative, ${r.nonNumeric} non-numeric`;
}

function html(label: string, s: HtmlStats): unknown[] {
  return [
    label,
    s.values,
    s.empty,
    s.html,
    s.plain,
    counts(s.tags),
    s.mentions,
    `${s.images.inlineBase64} (${formatBytes(s.images.inlineBase64Bytes)}) / ${s.images.remote} / ${s.images.other}`,
    s.links,
    counts(Object.fromEntries(Object.entries(s.unsafe).filter(([, n]) => n > 0))),
  ];
}

export function renderAuditMarkdown(report: AuditReport): string {
  const out: string[] = [];
  const h = (title: string) => out.push('', `## ${title}`, '');
  const c = report.counts;

  out.push(
    '# Legacy data audit (MIG-01)',
    '',
    `Generated ${report.generatedAt} from \`${report.source.project}\` (bucket \`${report.source.bucket}\`), read-only. ` +
      'Counts and shapes only: no titles, descriptions, comments, file names, client or referrer details.',
  );
  if (report.source.readOnly) {
    const ro = report.source.readOnly;
    out.push('', `**Read-only check:** passed. Granted: ${ro.granted.join(', ') || 'none'}. Write permissions: none.`);
  }
  out.push(
    '',
    `**Subject:** legacy uid \`${report.subject.uid}\`${report.subject.profileExists ? '' : ' (no profile found)'}.`,
  );

  h('Warnings');
  out.push(
    table(
      ['Code', 'Count', 'What it means'],
      report.warnings.map((w) => [`\`${w.code}\``, w.count, w.message]),
    ),
  );

  h('Scope');
  out.push(
    report.scope.rule === 'profile'
      ? 'From the mapping profile.'
      : 'Default rule: workflows the user owns or administers. The others are listed for a decision.',
    '',
    `Included: ${report.scope.included.join(', ') || 'none'}.`,
    '',
    table(
      ['Excluded workflow', 'Why'],
      report.scope.excluded.map((e) => [e.name, e.reason]),
    ),
  );

  h('Counts (in scope)');
  out.push(
    table(
      ['What', 'Count'],
      [
        ['Workflows (in scope / total)', `${c.workflows.inScope} / ${c.workflows.total}`],
        ['Workflows by visibility', counts(c.workflows.byVisibility)],
        ['Cards (active / archived)', `${c.cards.total} (${c.cards.active} / ${c.cards.archived})`],
        ['Checklists / items', `${c.checklists} / ${c.checklistItems}`],
        ['Comments', c.comments],
        ['History entries', c.history],
        ['Attachments', `${c.attachments.count} (${formatBytes(c.attachments.bytes)})`],
        ['Checklist templates', c.checklistTemplates],
        ['Referrers', c.referrers],
        ['Dashboard checklist items', c.dashboardItems],
        ['Integrations', `${c.integrations} (${counts(report.integrations)})`],
        ['Workspaces', `${c.workspaces} (${report.workspaces.prime} prime)`],
      ],
    ),
  );

  h('Workflows');
  out.push(
    table(
      [
        'Workflow',
        'Roles',
        'Scope',
        'Other members',
        'Cards (archived)',
        'Checklist items',
        'Comments',
        'History',
        'Attachments',
        'Templates',
        'With fee',
        'Billable',
        'With referrer',
      ],
      report.workflows.map((w) => [
        w.name,
        w.roles.join(', ') || '—',
        w.inScope ? (w.mode ?? 'in') : 'out',
        w.otherMembers,
        `${w.cards} (${w.archived})`,
        w.checklistItems,
        w.comments,
        w.history,
        `${w.attachments.count} (${formatBytes(w.attachments.bytes)})`,
        w.checklistTemplates,
        w.cardsWithFee,
        w.cardsBillable,
        w.cardsWithReferrer,
      ]),
    ),
  );
  for (const w of report.workflows) {
    out.push('', `### ${w.name}`, '');
    out.push(
      table(
        ['Swimlane', 'Id', 'Done lane', 'Cards', 'Archived'],
        w.swimlanes.map((s) => [
          s.title,
          `\`${s.id}\``,
          s.isDoneSwimlane === null ? '—' : s.isDoneSwimlane ? 'yes' : 'no',
          s.cards,
          s.archived,
        ]),
      ),
    );
    if (w.cardsInUnknownSwimlane)
      out.push('', `Cards in a swimlane the workflow no longer has: ${w.cardsInUnknownSwimlane}.`);
    out.push('', `Labels: ${w.labels.map((l) => `${l.name} (${l.cards})`).join(', ') || 'none'}.`);
    if (w.unknownLabelIds) out.push(`Label references to labels the workflow no longer has: ${w.unknownLabelIds}.`);
  }

  if (report.profileCoverage) {
    const p = report.profileCoverage;
    h('Mapping profile coverage');
    out.push(
      p.ok
        ? 'Every workflow and swimlane is mapped, and every mapping matches the data.'
        : 'The profile does not match the data exactly:',
      ...(p.unmappedWorkflows.length ? ['', `- Workflows with no mapping: ${p.unmappedWorkflows.join(', ')}`] : []),
      ...(p.unknownWorkflows.length ? [`- Mappings matching no workflow: ${p.unknownWorkflows.join(', ')}`] : []),
      ...p.unmappedSwimlanes.map((s) => `- Unmapped swimlane: ${s.workflow} › ${s.swimlane}`),
      ...p.unknownSwimlanes.map((s) => `- Mapping matching no swimlane: ${s.workflow} › ${s.swimlane}`),
    );
  }

  h('Referenced users');
  out.push(
    table(
      ['Uid', 'Name', 'Profile', 'References'],
      report.people.map((p) => [`\`${p.uid}\``, p.name ?? '—', p.exists ? 'yes' : 'missing', counts(p.references)]),
    ),
  );

  h('Billing and money');
  const m = report.money;
  out.push(
    table(
      ['What', 'Distribution or range'],
      [
        ['fee.billingType', counts(report.billing.billingType)],
        ['billable.status', counts(report.billing.billableStatus)],
        ['billable.postType', counts(report.billing.postType)],
        ['fee.splitFees', counts(report.billing.splitFees)],
        ['fee.value', range(m.feeValue)],
        ['fee.billedFees', range(m.billedFees)],
        ['fee.realisedFees (legacy)', range(m.realisedFees)],
        ['billable.billingTotal', range(m.billingTotal)],
        ['fee.ownershipPercentage', range(m.ownershipPercentage)],
        ['Profile FY budgets', range(m.budgets)],
      ],
    ),
    '',
    `**Amounts read as ${m.unit.guess}.** ${m.unit.reasons.join(' ')}`,
  );

  h('Legacy field names');
  out.push(table(['Field', 'Occurrences'], Object.entries(report.legacyFields)));

  h('Dates');
  out.push(
    table(
      ['Field', 'Shapes'],
      Object.entries(report.dates.fields).map(([field, shapes]) => [field, counts(shapes)]),
    ),
  );
  const d = report.dates.dueDates;
  out.push(
    '',
    `Due dates stored as instants: ${d.melbourneMidnight} at Melbourne midnight, ${d.utcMidnight} at UTC midnight, ` +
      `${d.otherTime} at another time; ${d.differsFromUtc} fall on a different day in Melbourne than in UTC. ` +
      `Documents updated before they were created: ${report.dates.updatedBeforeCreated}.`,
  );

  h('Rich text');
  out.push(
    table(
      [
        'Field',
        'Values',
        'Empty',
        'HTML',
        'Plain',
        'Tags',
        'Mentions',
        'Images (inline / remote / other)',
        'Links',
        'Unsafe',
      ],
      [
        html('Card descriptions', report.html.description),
        html('Comments', report.html.comment),
        html('History', report.html.history),
      ],
    ),
  );
  const classes = { ...report.html.description.classes };
  for (const [key, n] of Object.entries(report.html.comment.classes)) classes[key] = (classes[key] ?? 0) + n;
  out.push('', `Quill classes: ${counts(classes)}.`);

  h('Attachments');
  const a = report.attachments;
  out.push(
    table(
      ['What', 'Value'],
      [
        ['Count and size', `${a.count} (${formatBytes(a.bytes)}), largest ${formatBytes(a.maxBytes)}`],
        ['Over the legacy 25 MB limit', a.overLegacyLimit],
        ['By content type', counts(a.byMime)],
        ['By extension', counts(a.byExtension)],
        ['No content type', a.untyped],
        ['Not on the legacy allow-list', counts(a.notOnLegacyAllowList)],
        ['Not on the v2 upload allow-list', counts(a.notOnV2AllowList)],
        ['Recorded size differs from Storage', a.sizeMismatch],
      ],
    ),
  );

  h('Orphans and broken links');
  const o = report.orphans;
  const l = o.linkedCards;
  out.push(
    table(
      ['What', 'Count'],
      [
        ['Attachment docs without a Storage object', o.attachmentsWithoutObject.length],
        [
          'Storage objects without a doc',
          `${o.objectsWithoutDoc.count} (${formatBytes(o.objectsWithoutDoc.bytes)}; ${counts(o.objectsWithoutDoc.byKind)})`,
        ],
        [
          'Linked cards',
          `${l.total}: ${l.migrated} migrate, ${l.inExcludedWorkflow} in an excluded workflow, ${l.elsewhere} in another user's workflow, ${l.missing} missing`,
        ],
        ['Cards whose referrer is missing', o.referrerIdsWithoutReferrer],
      ],
    ),
  );
  if (o.attachmentsWithoutObject.length) out.push('', ...o.attachmentsWithoutObject.map((p) => `- \`${p}\``));

  h('Cards');
  const r = report.matterReference;
  out.push(
    table(
      ['What', 'Value'],
      [
        [
          'matterReference',
          `${r.set} set, ${r.empty} empty, ${r.null} null, ${r.missing} missing; ${r.duplicates} used more than once; ${r.invalidAsNumber} unusable as a v2 number; longest ${r.maxLength}; ${counts(r.shapes)}`,
        ],
        [
          'Titles',
          `${report.titles.empty} empty, ${report.titles.needsTrim} need trimming, longest ${report.titles.maxLength}`,
        ],
        ['Card ids', counts(report.ids.cardIds)],
        [
          'Id field differs (cards / workflowId / templates)',
          `${report.ids.cardIdFieldMismatch} / ${report.ids.cardWorkflowIdMismatch} / ${report.ids.templateIdMismatch}`,
        ],
        ['Priority (cards)', counts(report.priorities.cards)],
        ['Priority (checklist items)', counts(report.priorities.checklistItems)],
        ['Priority (dashboard items)', counts(report.priorities.dashboardItems)],
        [
          'Calendar-linked checklist items',
          `${report.calendar.linkedChecklistItems} (+${report.calendar.legacyCalendarSync} legacy calendarSync)`,
        ],
        [
          'Membership (duplicate uids / uids ≠ users)',
          `${report.membership.duplicateUids} / ${report.membership.uidsUsersDrift}`,
        ],
      ],
    ),
  );

  h('Referrers');
  const ref = report.referrers;
  out.push(
    table(
      ['What', 'Value'],
      [
        [
          'Total (person / organisation / neither)',
          `${ref.total} (${ref.person} / ${ref.organisation} / ${ref.neither})`,
        ],
        ['Industry (as v2 reads it)', counts(ref.industries)],
        ['Phones', counts(ref.phones)],
        ['Emails', counts(ref.emails)],
        ['Without timestamps', ref.withoutTimestamps],
        ['Used by cards', ref.usedByCards],
      ],
    ),
  );

  h('Profile and sign-in');
  const auth = report.auth;
  out.push(
    table(
      ['What', 'Value'],
      [
        ['Org name candidate (companyName)', report.profile.companyName ?? '— (falls back to "{name}\'s practice")'],
        ['FY budget fields', report.profile.hasBudgetFields ? 'present' : 'absent (profile predates them)'],
        ['Profile photo', report.profile.profileImage ? 'yes' : 'no'],
        ['Sign-in providers', auth ? (auth.found ? auth.providers.join(', ') || 'none' : 'no Auth user') : 'not read'],
        [
          'Password / MFA / disabled',
          auth?.found
            ? `${auth.hasPassword ? 'yes' : 'no'} / ${auth.mfaEnrolled ? 'yes' : 'no'} / ${auth.disabled ? 'yes' : 'no'}`
            : '—',
        ],
        ['Dashboard items (checked)', `${report.dashboardItems.total} (${report.dashboardItems.checked})`],
        ['Non-prime workspaces', report.workspaces.nonPrime.join(', ') || 'none'],
      ],
    ),
  );

  h('Field shapes');
  out.push('Every field seen, with how many parents could hold it and the shapes it held (`missing` when absent).');
  for (const [collection, histogram] of Object.entries(report.fields)) {
    out.push('', `### ${collection}`, '');
    out.push(
      table(
        ['Field', 'Of', 'Shapes'],
        Object.entries(histogram).map(([field, f]) => [`\`${field}\``, f.of, counts(f.shapes)]),
      ),
    );
  }

  return `${out.join('\n')}\n`;
}
