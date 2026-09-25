/** An error that maps to an HTTP status. Kept free of Next imports so the worker can use it. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown) {
    super(message);
  }
}
