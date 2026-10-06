import {
  cardKeyOf,
  docId,
  linkedCardKeys,
  profileName,
  referencedUids,
  taggedKind,
  valuesAt,
  workflowIdOf,
  workflowRoles,
} from './snapshot.ts';

describe('legacy snapshot helpers', () => {
  it('reads ids from paths', () => {
    expect(docId('workflows/w1/cards/c1')).toBe('c1');
    expect(workflowIdOf('workflows/w1/cards/c1/attachments/a1')).toBe('w1');
    expect(workflowIdOf('profiles/u1')).toBeUndefined();
    expect(cardKeyOf('workflows/w1/cards/c1/attachments/a1')).toBe('w1/c1');
    expect(cardKeyOf('workflows/w1')).toBeUndefined();
  });

  it('recognises tagged values only when they are exactly one tag', () => {
    expect(taggedKind({ $timestamp: '2025-01-01T00:00:00Z' })).toBe('timestamp');
    expect(taggedKind({ $bytes: 3 })).toBe('bytes');
    expect(taggedKind({ $timestamp: 'x', other: 1 })).toBeUndefined();
    expect(taggedKind({ name: 'x' })).toBeUndefined();
    expect(taggedKind('x')).toBeUndefined();
  });

  it('reads every value at a path, through arrays, counting missing fields', () => {
    const card = {
      checklists: [
        { items: [{ dueDate: 'a' }, { dueDate: null }, {}] },
        { items: [{ dueDate: 'b' }] },
        { title: 'no items' },
      ],
    };
    expect(valuesAt(card, 'checklists[].items[].dueDate')).toEqual(['a', null, undefined, 'b']);
    expect(valuesAt(card, 'fee.value')).toEqual([]);
    expect(valuesAt({ fee: { value: 3 } }, 'fee.value')).toEqual([3]);
  });

  it('reads linked cards in both the object and the bare-id legacy forms', () => {
    const card = {
      path: 'workflows/w1/cards/c1',
      data: { linkedCardIds: [{ cardId: 'c2', workflowId: 'w2' }, { cardId: 'c3' }, 'c4', '', { workflowId: 'w9' }] },
    };
    expect(linkedCardKeys(card)).toEqual(['w2/c2', 'w1/c3', 'w1/c4']);
    expect(linkedCardKeys({ path: 'workflows/w1/cards/c1', data: {} })).toEqual([]);
  });

  it('collects other users by kind of reference, never the user themselves', () => {
    const refs = referencedUids({
      uid: 'me',
      workflows: [{ path: 'workflows/w1', data: { uids: ['me', 'a', 'a'], users: { me: {}, b: {} } } }],
      cards: [
        {
          path: 'workflows/w1/cards/c1',
          data: {
            assignee: 'a',
            description: '<p><span class="mention" data-id="c">@C</span></p>',
            comments: [{ uid: 'b', comment: '<span class="ql-x mention" data-id="d"></span>' }, { uid: 'me' }],
            history: [{ uid: 'a' }, { uid: '' }],
          },
        },
      ],
      attachments: [{ path: 'workflows/w1/cards/c1/attachments/x', data: { uploadedBy: 'b' } }],
    });
    expect(Object.fromEntries(refs)).toEqual({
      a: { workflow_member: 1, assignee: 1, history_actor: 1 },
      b: { workflow_member: 1, comment_author: 1, attachment_uploader: 1 },
      c: { mention: 1 },
      d: { mention: 1 },
    });
  });

  it('names a profile by display name, else first and last name', () => {
    expect(profileName({ displayName: ' Alex Rivers ' })).toBe('Alex Rivers');
    expect(profileName({ displayName: '', firstName: 'Jordan', lastName: ' Ellis' })).toBe('Jordan Ellis');
    expect(profileName({ firstName: null, lastName: null })).toBeNull();
    expect(profileName(undefined)).toBeNull();
  });

  it("reads the user's workflow roles, including the legacy owner field", () => {
    expect(workflowRoles({ users: { me: { roles: { readWrite: true, admin: false, owner: true } } } }, 'me')).toEqual([
      'owner',
      'readWrite',
    ]);
    expect(workflowRoles({ owner: 'me' }, 'me')).toEqual(['owner']);
    expect(workflowRoles({ users: { other: { roles: { owner: true } } } }, 'me')).toEqual([]);
  });
});
