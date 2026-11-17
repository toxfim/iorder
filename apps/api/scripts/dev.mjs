// Dev loop without extra dependencies: tsc rebuilds on change, and the api is (re)started only
// after a compile that ends without errors. One compile is one restart: files tsc writes one by
// one, or other processes touching dist or packages/shared/dist, never restart the server, and
// the first start waits for the first compile instead of running the old dist and restarting.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const tscBin = createRequire(import.meta.url).resolve('typescript/bin/tsc');
// tsc --watch prints this after every compile, for example "Found 0 errors. Watching for file changes."
const COMPILE_DONE = /Found (\d+) errors?\. Watching for file changes\./;

let server = null;
let stopping = false;

function startServer() {
  server = spawn(process.execPath, ['--env-file-if-exists=../../.env', 'dist/main.js'], {
    stdio: 'inherit',
  });
  server.on('exit', () => {
    server = null;
  });
}

function restartServer() {
  if (server === null) {
    startServer();
    return;
  }
  console.log('[dev] Compiled, restarting the api');
  // Start the new one only after the old one let the port go.
  server.once('exit', () => {
    if (!stopping) startServer();
  });
  server.kill();
}

const tsc = spawn(
  process.execPath,
  [tscBin, '-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput'],
  { stdio: ['ignore', 'pipe', 'inherit'] },
);

let pending = '';
tsc.stdout.setEncoding('utf8');
tsc.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  pending += chunk;
  const lines = pending.split(/\r?\n/);
  pending = lines.pop() ?? '';
  for (const line of lines) {
    const match = COMPILE_DONE.exec(line);
    if (!match) continue;
    if (match[1] === '0') restartServer();
    else if (server !== null)
      console.log('[dev] Compile errors: the api keeps the last good build');
  }
});

function stop() {
  stopping = true;
  tsc.kill();
  server?.kill();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
tsc.on('exit', () => {
  stopping = true;
  server?.kill();
});
