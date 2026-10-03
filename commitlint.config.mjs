// Conventional Commits (CONTRIBUTING.md). PRs are squash-merged, so the PR title must pass too.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // PR titles start with "[KEY]", so squash commits on main use that form; allow long bodies.
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
  },
  ignores: [(message) => /^\[[A-Z]+-\d+[a-z]?\] /.test(message)],
};
