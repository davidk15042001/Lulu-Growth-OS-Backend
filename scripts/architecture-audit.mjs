import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const frontendRoot = process.argv[2] ? path.resolve(process.argv[2]) : null;
const ignored = new Set(['node_modules', '.git', 'dist', 'output', 'outputs', 'tmp', '.codex-build']);

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  return files;
}

function relative(file) {
  return path.relative(root, file).replaceAll('\\', '/');
}

const backendFiles = await walk(root);
const frontendFiles = frontendRoot ? await walk(frontendRoot) : [];
const sourceFiles = backendFiles.filter((file) => /\.(ts|tsx|js|mjs|sql)$/.test(file));
const runtimeFiles = sourceFiles.filter((file) => !/[\\/]src[\\/]database[\\/]migrations[\\/]/.test(file) && !/[\\/]tests[\\/]/.test(file));
const measured = [];
const findings = [];
for (const file of runtimeFiles) {
  const text = await fs.readFile(file, 'utf8');
  const lines = text.split(/\r?\n/).length;
  measured.push({ file: relative(file), lines, bytes: Buffer.byteLength(text) });
  if (/SELECT\s+\*/i.test(text)) findings.push({ file: relative(file), rule: 'select_star' });
  if (/FROM\s+workspace_records/i.test(text) && !/LIMIT\s+\$?\d+/i.test(text)) findings.push({ file: relative(file), rule: 'workspace_records_query_without_visible_limit' });
  if (/src[\\/]modules[\\/].*controller/i.test(file) && /\bquery\s*\(/.test(text)) findings.push({ file: relative(file), rule: 'sql_in_controller' });
}

const migrations = backendFiles.filter((file) => /src[\\/]database[\\/]migrations[\\/].+\.sql$/.test(file));
let tableCount = 0;
let indexCount = 0;
for (const file of migrations) {
  const text = await fs.readFile(file, 'utf8');
  tableCount += [...text.matchAll(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-z0-9_]+)/gi)].length;
  indexCount += [...text.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-z0-9_]+)/gi)].length;
}

const result = {
  generatedAt: new Date().toISOString(),
  backend: {
    sourceFileCount: sourceFiles.length,
    runtimeSourceFileCount: runtimeFiles.length,
    migrationCount: migrations.length,
    tableDefinitions: tableCount,
    indexDefinitions: indexCount,
    largestFiles: measured.sort((a, b) => b.lines - a.lines).slice(0, 25),
  },
  frontend: frontendRoot ? { root: frontendRoot, sourceFileCount: frontendFiles.filter((file) => /\.(ts|tsx|js|jsx)$/.test(file)).length } : null,
  findings: findings.slice(0, 200),
  note: 'This is a read-only heuristic inventory. Validate every finding with callers, schema and query plans before changing code.',
};
console.log(JSON.stringify(result, null, 2));
