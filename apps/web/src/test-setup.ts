// Unit tests share one browser storage across spec files; start each test without a remembered
// Matters view (CORE-03b), so a list opened in one spec doesn't reopen another spec's filters.
beforeEach(() => {
  localStorage.removeItem('materia.matters.view');
});
