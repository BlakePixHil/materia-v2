import { FICTIONAL_PEOPLE, fictionalPerson } from './fictional';

describe('fictionalPerson', () => {
  it('is deterministic and always returns a fictional person', () => {
    expect(fictionalPerson(0)).toEqual(FICTIONAL_PEOPLE[0]);
    expect(fictionalPerson(4)).toEqual(fictionalPerson(1));
    expect(fictionalPerson(-1)).toEqual(FICTIONAL_PEOPLE[1]);
  });
});
