/** Public errors contain only service-owned text, never runtime exception messages. */
export class ServiceError extends Error {
  constructor(code, status, message) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const unavailable = () => new ServiceError('UNAVAILABLE', 503, 'Rendering capacity is unavailable.');
