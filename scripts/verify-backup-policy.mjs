import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const backupDir = process.env.BACKUP_DIR;
const maxAgeHours = Number.parseInt(process.env.BACKUP_MAX_AGE_HOURS ?? '24', 10);
const strict = process.env.BACKUP_POLICY_STRICT === '1';
const remoteUri = process.env.BACKUP_REMOTE_URI?.trim() || null;

if (!backupDir) throw new Error('BACKUP_DIR must point to a protected backup directory');
if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) throw new Error('BACKUP_MAX_AGE_HOURS must be positive');

const resolvedDir = path.resolve(backupDir);
const forbiddenFragments = [`${path.sep}var${path.sep}www${path.sep}`, `${path.sep}public${path.sep}`, `${path.sep}html${path.sep}`];
if (forbiddenFragments.some((fragment) => resolvedDir.toLowerCase().includes(fragment.toLowerCase()))) {
  throw new Error(`Refusing backup directory inside a web-serving path: ${resolvedDir}`);
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(await fs.readFile(file));
  return hash.digest('hex');
}

const entries = await fs.readdir(resolvedDir, { withFileTypes: true });
const dumps = [];
for (const entry of entries) {
  if (!entry.isFile() || !/^lulu_growth_os_.+\.dump$/.test(entry.name)) continue;
  const file = path.join(resolvedDir, entry.name);
  const stat = await fs.stat(file);
  const checksumFile = `${file}.sha256`;
  let checksum = null;
  try {
    const expected = (await fs.readFile(checksumFile, 'utf8')).trim().split(/\s+/)[0];
    const actual = await sha256(file);
    checksum = { expected, actual, valid: expected === actual };
  } catch {
    checksum = { expected: null, actual: null, valid: false };
  }
  dumps.push({ file, modifiedAt: stat.mtime.toISOString(), ageHours: (Date.now() - stat.mtimeMs) / 3_600_000, checksum });
}
dumps.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
const latest = dumps[0] ?? null;
const failures = [];
if (!latest) failures.push('No PostgreSQL custom-format dump found');
if (latest && latest.ageHours > maxAgeHours) failures.push(`Latest backup is older than ${maxAgeHours} hours`);
if (latest && !latest.checksum.valid) failures.push('Latest backup checksum is missing or invalid');
if (strict && !remoteUri) failures.push('BACKUP_REMOTE_URI is required in strict mode for an independent failure domain');

const result = {
  ok: failures.length === 0,
  checkedAt: new Date().toISOString(),
  backupDir: resolvedDir,
  maxAgeHours,
  independentRemoteConfigured: Boolean(remoteUri),
  latest,
  backupCount: dumps.length,
  failures,
  note: 'This policy check is read-only; it does not upload, delete, or restore backups.',
};
console.log(JSON.stringify(result, null, 2));
if (failures.length > 0) process.exitCode = 1;

