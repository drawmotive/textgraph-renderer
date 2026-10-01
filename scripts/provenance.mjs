import { readFile, writeFile } from 'node:fs/promises';
import { abiManifest } from '@drawmotive/textgraph/node';

const service = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const provenance = { serviceVersion: service.version, sdkVersion: abiManifest.packageVersion, engineCommit: abiManifest.privateSource?.commit };
if (!provenance.engineCommit) throw new Error('Installed runtime has no producer provenance.');
if (process.env.EXPECTED_SERVICE_VERSION && process.env.EXPECTED_SERVICE_VERSION !== service.version) throw new Error('Service version build argument differs from package version.');
if (process.argv[2]) await writeFile(process.argv[2], `${JSON.stringify(provenance, null, 2)}\n`);
else process.stdout.write(`${JSON.stringify(provenance, null, 2)}\n`);
