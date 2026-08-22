import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const sourceDirectory = path.resolve('src/database/migrations');
const targetDirectory = path.resolve('dist/database/migrations');

await rm(targetDirectory, { recursive: true, force: true });
await mkdir(path.dirname(targetDirectory), { recursive: true });
await cp(sourceDirectory, targetDirectory, { recursive: true });

const copiedMigrations = (await readdir(targetDirectory)).filter((file) => file.endsWith('.sql'));
if (copiedMigrations.length === 0) {
  throw new Error('The production build contains no database migrations.');
}

console.log(`Copied ${copiedMigrations.length} database migrations into dist.`);
