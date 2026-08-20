import { spawn } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const nextBin = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
const wsServer = path.join(root, 'server', 'index.mjs');

const children = [];
let stopping = false;
const wsPort = process.env.WS_PORT || '8080';
const localWsUrl = process.env.NEXT_PUBLIC_WS_URL || `ws://127.0.0.1:${wsPort}`;

function start(label, args, env = process.env) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    env,
  });

  children.push(child);

  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(`\n[${label}] stopped (${signal || `exit ${code}`}). Shutting down dev stack...`);
    shutdown(code ?? 1);
  });

  return child;
}

function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;

  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }

  setTimeout(() => process.exit(exitCode), 250).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('Starting Temp Chat development stack...');
console.log('  Web: http://localhost:3000');
console.log(`  WS : ${localWsUrl}`);
console.log(`  Health: http://127.0.0.1:${wsPort}/health\n`);

start('websocket', [wsServer], { ...process.env, PORT: wsPort });
start('next', [nextBin, 'dev'], { ...process.env, NEXT_PUBLIC_WS_URL: localWsUrl });
