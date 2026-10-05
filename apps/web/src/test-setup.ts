// Unit tests share one browser storage across spec files; start each test without a remembered
// Matters view (CORE-03b) or matter events view, so one spec's choice doesn't leak into another.
beforeEach(() => {
  localStorage.removeItem('materia.matters.view');
  localStorage.removeItem('materia.matter.eventsView');
});
