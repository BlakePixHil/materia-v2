import { ENTITY_FACTORIES, makeMatter, makeTask } from './factories';

describe('factories', () => {
  it.each(Object.entries(ENTITY_FACTORIES))('make%s builds a valid document', (_name, [entity, make]) => {
    const doc = (make as () => unknown)();
    expect(entity.schema.safeParse(doc).success).toBe(true);
  });

  it('applies overrides and still validates them', () => {
    expect(makeMatter({ title: 'Estate of Robert Chen' }).title).toBe('Estate of Robert Chen');
    expect(() => makeTask({ status: 'nope' as never })).toThrow();
  });
});
