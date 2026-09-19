export class GuardrailError extends Error {
  constructor(public readonly violations: string[]) {
    super(violations.join('; '));
    this.name = 'GuardrailError';
  }
}
