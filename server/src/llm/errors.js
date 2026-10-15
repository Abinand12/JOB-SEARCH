export class LlmError extends Error {
  constructor(message, { status = 502, cause } = {}) {
    super(message, { cause });
    this.name = 'LlmError';
    this.status = status;
  }
}
