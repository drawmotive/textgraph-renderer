import { readConfig } from './config.js';
import { RenderPool } from './pool.js';
import { createService } from './server.js';

async function main() {
  const config = readConfig();
  const pool = new RenderPool({ ...config, onStartupError: code => {
    process.stderr.write(code === 'UNSUPPORTED_CAPABILITY'
      ? 'UNSUPPORTED_CAPABILITY: Install a TextGraph SDK with textgraph-render-svg-v1.\n'
      : `${code}: Rendering Worker is unavailable.\n`);
  } });
  const service = createService({ pool, ...config });
  const stop = () => service.close();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await service.listen(config.port, config.host);
  await pool.start();
  process.stdout.write(`TextGraph renderer listening on port ${config.port}.\n`);
}
main().catch(() => { process.stderr.write('TextGraph renderer could not start. Check service configuration and bind address.\n'); process.exitCode = 1; });
