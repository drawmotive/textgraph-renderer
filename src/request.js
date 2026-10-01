import { ServiceError } from './errors.js';

/** Enforce byte/time bounds during streaming, including bodies without Content-Length. */
export function readJson(request, { bodyLimitBytes, bodyTimeoutMs }) {
  return new Promise((resolve, reject) => {
    const length = request.headers['content-length'];
    if (length !== undefined && Number(length) > bodyLimitBytes) {
      reject(new ServiceError('BODY_TOO_LARGE', 413, 'The request body is too large.'));
      return;
    }
    let size = 0;
    const chunks = [];
    const finish = (error, value) => {
      clearTimeout(timer);
      request.removeListener('data', data);
      request.removeListener('end', end);
      request.removeListener('aborted', aborted);
      request.removeListener('error', aborted);
      if (error) { request.pause(); reject(error); } else resolve(value);
    };
    const data = chunk => {
      size += chunk.byteLength;
      if (size > bodyLimitBytes) finish(new ServiceError('BODY_TOO_LARGE', 413, 'The request body is too large.'));
      else chunks.push(chunk);
    };
    const end = () => {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
        finish(null, JSON.parse(text));
      } catch { finish(new ServiceError('INVALID_JSON', 400, 'The request body must be valid UTF-8 JSON.')); }
    };
    const aborted = () => finish(new ServiceError('CANCELLED', 499, 'The request was cancelled.'));
    const timer = setTimeout(() => finish(new ServiceError('BODY_TIMEOUT', 408, 'The request body exceeded its deadline.')), bodyTimeoutMs);
    request.on('data', data);
    request.once('end', end);
    request.once('aborted', aborted);
    request.once('error', aborted);
  });
}

/** HTTP options follow the SDK contract; floats must survive its float32 boundary. */
export function validateInput(value, format) {
  const fail = () => { throw new ServiceError('INVALID_REQUEST', 400, 'The request contains invalid rendering options.'); };
  const allowed = format === 'png' ? ['source', 'padding', 'language', 'scale', 'maxWidth'] : ['source', 'padding', 'language'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.source !== 'string' || Object.keys(value).some(key => !allowed.includes(key))) fail();
  const padding = value.padding === undefined ? 10 : value.padding;
  if (!Number.isFinite(padding) || !Number.isFinite(Math.fround(padding)) || padding < 0) fail();
  if (value.language !== undefined && (typeof value.language !== 'string' || !/^[a-z]{2,8}(?:-[A-Za-z0-9]+)*$/.test(value.language))) fail();
  const input = { source: value.source, padding, ...(value.language === undefined ? {} : { language: value.language }) };
  if (format === 'png') {
    const scale = value.scale === undefined ? 1 : value.scale;
    if (!Number.isFinite(scale) || !Number.isFinite(Math.fround(scale)) || Math.fround(scale) <= 0) fail();
    if (value.maxWidth !== undefined && (!Number.isSafeInteger(value.maxWidth) || value.maxWidth <= 0)) fail();
    input.scale = scale;
    if (value.maxWidth !== undefined) input.maxWidth = value.maxWidth;
  }
  return input;
}
