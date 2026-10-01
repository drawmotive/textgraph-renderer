import { parentPort, workerData } from 'node:worker_threads';
import { serveWorker } from '../../src/worker-host.js';

serveWorker(parentPort, async () => {
  if (workerData?.startupFailure) throw Object.assign(new Error('SECRET runtime stack'), { code: workerData.startupFailure });
  let count = 0;
  return { render: async (format, input) => {
    count++;
    if (input.source === 'throw') throw new Error('SECRET render stack');
    return format === 'png'
      ? { success: true, png: Uint8Array.from([137,80,78,71,13,10,26,10]), diagnostics: [], count }
      : { success: true, svg: `<svg>${count}</svg>`, diagnostics: [] };
  } };
});
