import { parentPort } from 'node:worker_threads';
import { createEngine } from './engine.js';
import { serveWorker } from './worker-host.js';

await serveWorker(parentPort, createEngine);
