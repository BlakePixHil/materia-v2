/** Thrown when a value can't be parsed into a domain type. Carries the offending input. */
export class DomainValueError extends Error {
  constructor(
    readonly kind: 'DateOnly' | 'Instant' | 'Cents' | 'Minutes' | 'Id',
    readonly input: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'DomainValueError';
  }
}
