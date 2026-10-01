import { parentPort, threadId, workerData } from 'node:worker_threads';

if (workerData?.startup === 'fail') {
  parentPort.postMessage({ type: 'startup-error' });
} else if (workerData?.startup !== 'hang') {
  setTimeout(() => parentPort.postMessage({ type: 'ready' }), workerData?.startupDelay ?? 0);
}
parentPort.on('message', async ({ id, format, input }) => {
  if (input.source === 'hang') { while (true) {} }
  if (input.source === 'crash') process.exit(1);
  if (input.source === 'throw') { parentPort.postMessage({ type: 'failure', id }); return; }
  if (input.source === 'wait') await new Promise(resolve => setTimeout(resolve, 150));
  const diagnostics = input.source === 'invalid'
    ? [{ severity: 'error', code: 'TG001', message: 'Invalid syntax', stage: 'parse', location: { start: 2, length: 1, line: 0, column: 2 } }]
    : input.source === 'warning' ? [{ severity: 'warning', code: 'TG002', message: 'Warning', stage: 'layout' }] : [];
  const result = diagnostics.some(item => item.severity === 'error')
    ? { success: false, diagnostics }
    : format === 'svg'
      ? { success: true, svg: `<svg xmlns="http://www.w3.org/2000/svg"><text>${threadId}:${JSON.stringify(input)}</text></svg>`, displayWidth: 100, displayHeight: 50, diagnostics }
      : { success: true, png: Uint8Array.from([137,80,78,71,13,10,26,10]), width: 100, height: 50, displayWidth: 100, displayHeight: 50, diagnostics };
  parentPort.postMessage({ type: 'result', id, result });
});
