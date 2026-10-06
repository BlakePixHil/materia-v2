import { fakeKmsSeal } from '../../e2e/clerk';

/** The e2e key helper (AI-06) must seal exactly as the emulator's fake KMS opens. */
describe('fakeKmsSeal', () => {
  it('matches the functions’ FakeKms (a vector from FakeKms.encrypt)', () => {
    expect(fakeKmsSeal('sk-ant-api03-fictional-vector-0000', 'orgs/org-vector/integrations/anthropic')).toBe(
      'fakekms.7Eg3H0RuiOGTIj6GnzsPMcpAo3IjQnlhsftxgwDU4oquEz1cHw==',
    );
  });
});
