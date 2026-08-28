export class InvalidPathQueryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidPathQueryError';
  }
}

export class PathQueryCancelledError extends Error {
  public constructor() {
    super('Path query execution was cancelled');
    this.name = 'PathQueryCancelledError';
  }
}
