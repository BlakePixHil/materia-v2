// Runs on staged files before each commit (husky pre-commit).
export default {
  '*.{ts,mts,cts,js,mjs,cjs,html,css,json,yml,yaml}': 'prettier --write',
  '{apps,libs,tools}/**/*.{ts,mts,js,mjs,html}': 'eslint --fix --no-warn-ignored',
};
