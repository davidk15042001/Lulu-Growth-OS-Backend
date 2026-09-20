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
const reviewFindings = [];
const blockingViolations = [];
const checkedRules = [
  'no SELECT * in runtime source',
  'workspace_records list queries expose a bounded LIMIT',
  'controllers do not execute SQL directly',
  'provider SDK calls stay behind adapter/provider-control boundaries',
  'runtime configuration reads are centralized for review',
  'frontend does not import backend source or build output',
  'very large runtime files are reviewed before further growth',
];
for (const file of runtimeFiles) {
  const text = await fs.readFile(file, 'utf8');
  const lines = text.split(/\r?\n/).length;
  measured.push({ file: relative(file), lines, bytes: Buffer.byteLength(text) });
  if (/SELECT\s+\*/i.test(text)) reviewFindings.push({ file: relative(file), rule: 'select_star' });
  if (/FROM\s+workspace_records/i.test(text) && !/LIMIT\s+\$?\d+/i.test(text)) reviewFindings.push({ file: relative(file), rule: 'workspace_records_query_without_visible_limit' });
  if (/src[\\/]modules[\\/].*controller/i.test(file) && /\bquery\s*\(/.test(text)) reviewFindings.push({ file: relative(file), rule: 'sql_in_controller' });
  if (lines > 1500) reviewFindings.push({ file: relative(file), rule: 'runtime_file_over_1500_lines', lines });
  if (/\bprocess\.env\.[A-Z0-9_]+/.test(text) && !/[\\/]src[\\/]config[\\/]/.test(file)) {
    reviewFindings.push({ file: relative(file), rule: 'direct_process_env_outside_config' });
  }
  if (/from\s+['"](?:openai|twilio|imapflow|@aws-sdk|@composio|nodemailer|pdfkit|pg)['"]/i.test(text)
      && !/[\\/]src[\\/](modules[\\/](ai|premium-media|provider-control)|providers[\\/]|db[\\/])/.test(file)) {
    reviewFindings.push({ file: relative(file), rule: 'provider_sdk_import_outside_adapter_boundary' });
  }
}

for (const file of frontendFiles.filter((candidate) => /\.(ts|tsx|js|jsx|mjs)$/.test(candidate))) {
  const text = await fs.readFile(file, 'utf8');
  if (/(?:backend[\\/](?:src|dist)|Lulu-Growth-OS-Backend[\\/](?:src|dist))/.test(text)) {
    blockingViolations.push({ file: path.relative(frontendRoot, file).replaceAll('\\', '/'), rule: 'frontend_imports_backend_source_or_build' });
  }
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
  policy: {
    strict: process.env.ARCHITECTURE_AUDIT_STRICT === '1',
    blockingViolations,
    reviewFindings: reviewFindings.slice(0, 300),
    reviewFindingCount: reviewFindings.length,
    checkedRules,
    note: 'Blocking violations fail strict mode. Review findings are intentionally non-blocking until validated with callers, schema and query plans.',
  },
};
console.log(JSON.stringify(result, null, 2));
if (result.policy.strict && blockingViolations.length > 0) process.exitCode = 1;
