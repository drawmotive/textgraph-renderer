import http from 'node:http';
import { ServiceError, unavailable } from './errors.js';
import { readJson, validateInput } from './request.js';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Expose-Headers': 'X-TextGraph-Warning-Count',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

/** HTTP remains independent of CPU-bound work; only the pool grants render capacity. */
export function createService({ pool, bodyLimitBytes = 65536, bodyTimeoutMs = 10000 }) {
  let closing = false;
  let shutdown;
  const server = http.createServer((request, response) => {
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
    const controller = new AbortController();
    const cancel = () => { if (!response.writableEnded) controller.abort(); };
    request.once('aborted', cancel);
    response.once('close', cancel);
    const finish = () => { request.removeListener('aborted', cancel); response.removeListener('close', cancel); };
    (async () => {
      if (closing) throw unavailable();
      const path = new URL(request.url, 'http://localhost').pathname;
      const format = path === '/api/v1/render/png' ? 'png' : path === '/api/v1/render/svg' ? 'svg' : null;
      if (!format && path !== '/health') throw new ServiceError('NOT_FOUND', 404, 'The requested route does not exist.');
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
      if (path === '/health' && request.method === 'GET') {
        const health = pool.health();
        json(response, health.ready ? 200 : 503, { status: health.ready ? 'ready' : 'unavailable', ...health });
        return;
      }
      if (request.method !== 'POST' || !format) {
        response.setHeader('Allow', path === '/health' ? 'GET, OPTIONS' : 'POST, OPTIONS');
        throw new ServiceError('METHOD_NOT_ALLOWED', 405, 'The request method is not allowed.');
      }
      const contentType = request.headers['content-type']?.split(';')[0].trim().toLowerCase();
      if (contentType !== 'application/json') throw new ServiceError('UNSUPPORTED_MEDIA_TYPE', 415, 'The request Content-Type must be application/json.');
      const input = validateInput(await readJson(request, { bodyLimitBytes, bodyTimeoutMs }), format);
      const result = await pool.render(format, input, { signal: controller.signal });
      if (controller.signal.aborted || response.destroyed) return;
      const warningCount = result.diagnostics.filter(item => item.severity === 'warning').length;
      response.setHeader('X-TextGraph-Warning-Count', String(warningCount));
      if (!result.success) {
        json(response, 422, { code: 'RENDER_FAILED', message: 'The diagram could not be rendered.', diagnostics: result.diagnostics });
        return;
      }
      response.writeHead(200, { 'Content-Type': format === 'png' ? 'image/png' : 'image/svg+xml; charset=utf-8' });
      response.end(format === 'png' ? Buffer.from(result.png) : result.svg);
    })().catch(error => {
      if (response.destroyed || controller.signal.aborted) return;
      const safe = error instanceof ServiceError ? error : new ServiceError('INTERNAL_ERROR', 500, 'The request could not be completed.');
      if (safe.status === 429) response.setHeader('Retry-After', '1');
      // A rejected or incomplete body is never reused as the next keep-alive request.
      if (!request.complete) response.setHeader('Connection', 'close');
      json(response, safe.status, { code: safe.code, message: safe.message });
    }).finally(finish);
  });
  server.requestTimeout = 0; // readJson owns the shorter, response-producing body deadline.
  server.headersTimeout = Math.max(10000, bodyTimeoutMs);
  return {
    server,
    listen: (port, host) => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
    }),
    close: () => shutdown ??= (async () => {
      closing = true;
      const closed = new Promise(resolve => server.close(resolve));
      await pool.close();
      server.closeAllConnections();
      await closed;
    })(),
  };
}
