import { spawn } from 'node:child_process';
import path from 'node:path';

const port = 4010;
const childEnv = { ...process.env };
delete childEnv.DATABASE_URL;

const child = spawn(process.execPath, ['dist/server.js'], {
  env: {
    ...childEnv,
    // A production bundle smoke test must not depend on a developer's local
    // database or optional provider keys from `.env`.
    DOTENV_CONFIG_PATH: path.resolve('.env.smoke-disabled'),
    PORT: String(port),
    NODE_ENV: 'test',
    JWT_SECRET: '0123456789abcdef0123456789abcdef',
    RUN_MIGRATIONS_ON_STARTUP: 'false',
    BACKGROUND_WORKERS_ENABLED: 'false',
    LOG_LEVEL: 'fatal',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += String(chunk);
});

try {
  let response;
  // Cold starts on production-sized bundles can take several seconds on busy
  // CI hosts. Keep polling the health endpoint instead of reporting a false
  // failure after the previous three-second window.
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) break;
    } catch {
      // The child process may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (!response?.ok) {
    throw new Error(`Built server health check failed. ${stderr}`);
  }

  const body = await response.json();
  if (body?.data?.status !== 'ok') {
    throw new Error(`Unexpected health response: ${JSON.stringify(body)}`);
  }

  console.log(`Built server health check passed on port ${port}`);
} finally {
  child.kill();
}
