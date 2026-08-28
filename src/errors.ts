export class InvalidPathQueryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidPathQueryError';
  }
}

export class UnsupportedPathTermError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'UnsupportedPathTermError';
  }
}

