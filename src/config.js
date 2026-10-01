/** Reject unusable startup limits before opening sockets or allocating WASM Workers. */
export function readConfig(environment = process.env) {
  const invalid = () => { throw new Error('Invalid service configuration.'); };
  const integer = (name, fallback, maximum) => {
    if (environment[name] === undefined) return fallback;
    if (!/^[0-9]+$/.test(environment[name])) invalid();
    const value = Number(environment[name]);
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) invalid();
    return value;
  };
  const host = environment.HOST ?? '0.0.0.0';
  if (typeof host !== 'string' || !host.trim() || host !== host.trim()) invalid();
  return {
    port: integer('PORT', 8080, 65535),
    host,
    size: integer('WORKER_COUNT', 1, 8),
    renderTimeoutMs: integer('RENDER_TIMEOUT_MS', 30000, 2147483647),
    startupTimeoutMs: integer('WORKER_STARTUP_TIMEOUT_MS', 30000, 2147483647),
    bodyLimitBytes: integer('BODY_LIMIT_BYTES', 65536, 2147483647),
    bodyTimeoutMs: integer('BODY_TIMEOUT_MS', 10000, 2147483647),
  };
}
