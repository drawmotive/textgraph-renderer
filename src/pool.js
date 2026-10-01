import { Worker } from 'node:worker_threads';
import { ServiceError, unavailable } from './errors.js';

/** A slot is usable only after initialization. No work waits behind an occupied slot. */
export class RenderPool {
  #slots;
  #options;
  #started;
  #closed = false;
  #sequence = 0;
  #retirements = new Set();

  constructor({ size = 1, workerUrl = new URL('./worker.js', import.meta.url), workerData, renderTimeoutMs = 30000, startupTimeoutMs = 30000, onStartupError = () => {} } = {}) {
    this.#options = { workerUrl, workerData, renderTimeoutMs, startupTimeoutMs, onStartupError };
    this.#slots = Array.from({ length: size }, () => ({ state: 'unavailable', worker: null, operation: null }));
  }

  start() {
    return this.#started ??= Promise.all(this.#slots.map(slot => this.#initialize(slot))).then(() => undefined);
  }

  health() {
    return {
      capacity: this.#slots.length,
      ready: this.#slots.filter(slot => slot.state === 'ready' || slot.state === 'busy').length,
      busy: this.#slots.filter(slot => slot.state === 'busy').length,
      unavailable: this.#slots.filter(slot => slot.state !== 'ready' && slot.state !== 'busy').length,
    };
  }

  async render(format, input, { signal } = {}) {
    if (this.#closed) throw unavailable();
    if (signal?.aborted) throw new ServiceError('CANCELLED', 499, 'The request was cancelled.');
    const slot = this.#slots.find(item => item.state === 'ready');
    if (!slot) {
      if (this.#slots.some(item => item.state === 'busy')) throw new ServiceError('BUSY', 429, 'Rendering capacity is occupied.');
      throw unavailable();
    }
    slot.state = 'busy';
    return new Promise((resolve, reject) => {
      const operation = { id: ++this.#sequence, resolve, reject, signal };
      const cancel = () => this.#retire(slot, new ServiceError('CANCELLED', 499, 'The request was cancelled.'), true);
      operation.cancel = cancel;
      operation.timer = setTimeout(() => this.#retire(slot, new ServiceError('RENDER_TIMEOUT', 504, 'Rendering exceeded its deadline.'), true), this.#options.renderTimeoutMs);
      slot.operation = operation;
      signal?.addEventListener('abort', cancel, { once: true });
      try { slot.worker.postMessage({ id: operation.id, format, input }); }
      catch { this.#retire(slot, unavailable(), true); }
    });
  }

  async #initialize(slot) {
    if (this.#closed) return;
    slot.state = 'initializing';
    await new Promise(resolve => {
      let worker;
      const initialized = () => {
        clearTimeout(slot.startupTimer);
        slot.startupComplete = null;
        resolve();
      };
      slot.startupComplete = initialized;
      try {
        worker = new Worker(this.#options.workerUrl, { workerData: this.#options.workerData });
        slot.worker = worker;
      } catch {
        slot.state = 'unavailable';
        initialized();
        this.#options.onStartupError('WORKER_STARTUP_FAILED');
        return;
      }
      slot.startupTimer = setTimeout(() => {
        this.#options.onStartupError('WORKER_STARTUP_TIMEOUT');
        this.#retire(slot, unavailable(), false);
      }, this.#options.startupTimeoutMs);
      worker.on('message', message => {
        if (slot.worker !== worker) return;
        if (slot.state === 'initializing') {
          if (message?.type === 'ready') {
            slot.state = 'ready';
            initialized();
          } else if (message?.type === 'startup-error') {
            this.#options.onStartupError(message.code === 'UNSUPPORTED_CAPABILITY' ? message.code : 'WORKER_STARTUP_FAILED');
            this.#retire(slot, unavailable(), false);
          }
          return;
        }
        if (slot.state !== 'busy' || message?.id !== slot.operation?.id) return;
        if (message.type === 'failure') this.#retire(slot, unavailable(), true);
        else if (message.type === 'result') {
          const operation = this.#clearOperation(slot);
          slot.state = 'ready';
          operation.resolve(message.result);
        }
      });
      const failed = () => {
        if (slot.worker !== worker) return;
        const restart = slot.state !== 'initializing';
        if (!restart) this.#options.onStartupError('WORKER_STARTUP_FAILED');
        this.#retire(slot, unavailable(), restart);
      };
      worker.on('error', failed);
      worker.on('exit', failed);
    });
  }

  #clearOperation(slot) {
    const operation = slot.operation;
    slot.operation = null;
    if (operation) {
      clearTimeout(operation.timer);
      operation.signal?.removeEventListener('abort', operation.cancel);
    }
    return operation;
  }

  #retire(slot, error, replace) {
    if (!slot.worker) return;
    // Invalidating the old identity synchronously isolates late replies/exits.
    // Replacement initialization starts only after terminate() has stopped WASM.
    const worker = slot.worker;
    slot.worker = null;
    slot.state = 'replacing';
    clearTimeout(slot.startupTimer);
    slot.startupComplete?.();
    this.#clearOperation(slot)?.reject(error);
    const retirement = (async () => {
      try { await worker.terminate(); } catch { /* Termination already in progress. */ }
      slot.state = 'unavailable';
      if (replace && !this.#closed) await this.#initialize(slot);
    })();
    this.#retirements.add(retirement);
    retirement.finally(() => this.#retirements.delete(retirement));
    return retirement;
  }

  async close() {
    this.#closed = true;
    for (const slot of this.#slots) this.#retire(slot, unavailable(), false);
    await Promise.all([...this.#retirements]);
  }
}
