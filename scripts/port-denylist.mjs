import fs from 'node:fs';
import path from 'node:path';

const scanRoots = [
  '.claude', '.codex', '.gemini', '.grok', 'bin', 'packages', 'scripts',
];
const extensions = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.json', '.yaml', '.yml', '.md', '.sh']);
const skippedDirectories = new Set(['node_modules', '.git', 'coverage', 'dist', 'build', '.turbo']);
const allowedPathFragments = [
  'port-denylist',
  `${path.sep}packages${path.sep}installer${path.sep}src${path.sep}enterprise${path.sep}`,
  `${path.sep}packages${path.sep}installer${path.sep}tests${path.sep}`,
  `${path.sep}scripts${path.sep}e2e${path.sep}pro-to-enterprise`,
];
const patterns = [
  ['workspace-product', 'Hub/enterprise workspace tree path', /(?:^|[\s'"=(`])(?:\.\.?\/)?workspace\/[A-Za-z0-9_.-]+/],
  ['secrets-path', 'Product secret-store path must not be ported into OSS', /(?:^|[\s'"=(])(?:\.\.?\/)?secrets\/[A-Za-z0-9_./-]+/i],
  ['sinkra-prefix', 'Sinkra product prefix (skills, modules, env)', /\bsinkra[_-]/i],
  ['sinkra-dot-path', 'Sinkra local canon path', /\.sinkra\//],
  ['mux-adapter', 'Hub mux-adapter / conductor product service', /\bmux-adapter\b/],
  ['coolify', 'Product deploy host hardcode', /\bcoolify\b/i],
  ['machine-path-users', 'Machine-specific absolute path (/Users/...)', /\/Users\/[A-Za-z0-9_.-]+/],
  ['machine-path-home', 'Machine-specific absolute path (/home/...)', /\/home\/[A-Za-z0-9_.-]+\//],
  ['machine-path-windows', 'Machine-specific Windows user path', /C:\\Users\\[A-Za-z0-9_.-]+/i],
  ['hardcoded-credential', 'Probable hardcoded credential value', /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\s*[:=]\s*['"][^'"$\n]{16,}['"]/i],
];

function isAllowed(file) {
  return allowedPathFragments.some((fragment) => file.includes(fragment));
}

function walk(directory, files, findings) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    findings.push({ file: directory, line: 0, id: 'scan-error', description: error.message });
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) walk(fullPath, files, findings);
    } else if (entry.isFile() && (extensions.has(path.extname(entry.name)) || entry.name === 'Dockerfile')) {
      files.push(fullPath);
    }
  }
}

export function scanProject({ projectRoot = process.cwd() } = {}) {
  const findings = [];
  const files = [];
  for (const root of scanRoots) {
    const absoluteRoot = path.join(projectRoot, root);
    if (fs.existsSync(absoluteRoot)) walk(absoluteRoot, files, findings);
  }
  for (const file of files) {
    if (isAllowed(file)) continue;
    const isTest = file.includes(`${path.sep}tests${path.sep}`) || file.endsWith('.test.js');
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      for (const [id, description, expression] of patterns) {
        if (isTest && id.startsWith('machine-path')) continue;
        if (expression.test(lines[index])) {
          findings.push({ file: path.relative(projectRoot, file), line: index + 1, id, description });
        }
      }
    }
  }
  return { ok: findings.length === 0, findings, filesScanned: files.length };
}
