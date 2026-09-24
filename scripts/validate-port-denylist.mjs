import path from 'node:path';
import { fileURLToPath } from 'node:url';
import portDenylist from '../.aiox-core/core/security/port-denylist.js';

const { scanProject } = portDenylist;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const result = scanProject({ projectRoot });

if (result.ok) {
  console.log(`OSS port denylist clean (${result.filesScanned} files scanned)`);
  process.exit(0);
}

console.error(`OSS port denylist failed with ${result.findings.length} finding(s):`);
for (const finding of result.findings) {
  console.error(`${finding.file}:${finding.line} [${finding.id}] ${finding.description}`);
}
process.exit(1);
