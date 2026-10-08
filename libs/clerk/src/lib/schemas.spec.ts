import { ChatProposalsOutput, OUTPUT_SCHEMAS, chatProposalsFromReply, type ChatProposalsReply } from './schemas';

/** The chat proposals reply (AI-06, AI-10b) and the proposals built from it. Everything here is fictional. */

const why = { rationale: 'The answer says so.', citations: [] };
const reply = (lists: Partial<ChatProposalsReply>): ChatProposalsReply => ({
  tasks: [],
  deadlines: [],
  events: [],
  notes: [],
  keyFacts: [],
  letters: [],
  ...lists,
});

describe('chatProposalsFromReply', () => {
  it('builds each kind’s proposal, leaving out the values given as empty', () => {
    const { proposals } = chatProposalsFromReply(
      reply({
        tasks: [{ title: 'Order certified copies', details: '', dueDate: '2026-11-02', priority: 'high', ...why }],
        deadlines: [
          { title: 'File the inventory', dueDate: '2026-12-01', dueTime: '', kind: 'court', critical: true, ...why },
        ],
        events: [{ eventId: '', kind: 'grant_issued', date: '2026-10-01', time: '', label: ' ', ...why }],
        notes: [{ bodyMd: 'Executor called about the house.', ...why }],
        keyFacts: [
          { field: 'grossValue', value: '125000000', ...why },
          { field: 'grantNo', value: 'S PRB 2026 01234', ...why },
        ],
        letters: [{ typeId: 'grant-notification', partyIds: ['p-1'], instructions: 'Say the grant issued.', ...why }],
      }),
    );
    expect(proposals.map((p) => p.kind)).toEqual(['task', 'deadline', 'event', 'note', 'key_fact']);
    expect(proposals[0]?.payload).toEqual({ title: 'Order certified copies', priority: 'high', dueDate: '2026-11-02' });
    expect(proposals[1]?.payload).toEqual({
      title: 'File the inventory',
      dueDate: '2026-12-01',
      kind: 'court',
      critical: true,
    });
    expect(proposals[2]?.payload).toEqual({ kind: 'grant_issued', date: '2026-10-01' });
    // Money is whole cents, as a number.
    expect(proposals[4]?.payload).toEqual({ field: 'grossValue', value: 125000000 });
    expect(proposals[4]?.rationale).toBe('The answer says so.');
    // At most five: the second key fact and the letter come after.
    expect(proposals).toHaveLength(5);
  });

  it('leaves out a proposal its kind rejects, keeping the rest', () => {
    const { proposals } = chatProposalsFromReply(
      reply({
        tasks: [
          {
            title: 'Chase the bank',
            details: 'Ask for the date-of-death balance.',
            dueDate: 'next week',
            priority: 'none',
            ...why,
          },
          {
            title: 'Chase the bank',
            details: 'Ask for the date-of-death balance.',
            dueDate: '',
            priority: 'none',
            ...why,
          },
        ],
        keyFacts: [{ field: 'dateOfDeath', value: '3 March 2026', ...why }],
        letters: [{ typeId: 'client-update', partyIds: [], instructions: 'Update the executor.', ...why }],
      }),
    );
    expect(proposals).toEqual([
      {
        kind: 'task',
        payload: { title: 'Chase the bank', priority: 'none', descriptionMd: 'Ask for the date-of-death balance.' },
        ...why,
      },
      {
        kind: 'letter',
        payload: { typeId: 'client-update', partyIds: [], instructions: 'Update the executor.' },
        ...why,
      },
    ]);
    expect(ChatProposalsOutput.parse({ proposals })).toEqual({ proposals });
  });

  it('is what the gateway parses a reply to; a reply missing a list is invalid', () => {
    const parsed = OUTPUT_SCHEMAS.chatProposals.parse(reply({ notes: [{ bodyMd: 'A note.', ...why }] }));
    expect(parsed).toEqual({ proposals: [{ kind: 'note', payload: { bodyMd: 'A note.', pinned: false }, ...why }] });
    expect(OUTPUT_SCHEMAS.chatProposals.safeParse({ proposals: [] }).success).toBe(false);
  });
});
