/** Keep operational failures private and transfer raster ownership to the HTTP process. */
export async function serveWorker(port, initialize) {
  let engine;
  try { engine = await initialize(); }
  catch (error) {
    port.postMessage({ type: 'startup-error', code: error?.code === 'UNSUPPORTED_CAPABILITY' ? error.code : 'WORKER_STARTUP_FAILED' });
    port.close();
    return;
  }
  port.on('message', async ({ id, format, input }) => {
    try {
      const result = await engine.render(format, input);
      if (result.success && format === 'png') {
        // A dedicated buffer excludes unrelated bytes when the SDK returns a view.
        const png = Uint8Array.from(result.png);
        port.postMessage({ type: 'result', id, result: { ...result, png } }, [png.buffer]);
      } else port.postMessage({ type: 'result', id, result });
    } catch { port.postMessage({ type: 'failure', id }); }
  });
  port.postMessage({ type: 'ready' });
}
