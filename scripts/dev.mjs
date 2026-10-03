import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const nodeScript = (path) => fileURLToPath(new URL(path, import.meta.url));
const children = [];

function run(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${script} exited with code ${code ?? 'unknown'}`)));
  });
}

await run(nodeScript('../node_modules/typescript/bin/tsc'), ['-b']);
await run(nodeScript('../node_modules/vite/bin/vite.js'), ['build']);
await import('./ensure-dev-vars.mjs');
await run(nodeScript('../node_modules/wrangler/bin/wrangler.js'), ['d1', 'migrations', 'apply', 'model-monitor', '--local']);

function stop(code = 0) {
  for (const child of children) if (child.exitCode === null) child.kill();
  process.exit(code);
}

process.on('SIGINT', () => stop(130));
process.on('SIGTERM', () => stop(143));

const worker = spawn(process.execPath, [nodeScript('../node_modules/wrangler/bin/wrangler.js'), 'dev', '--port', '8787'], { cwd: root, stdio: 'inherit' });
const vite = spawn(process.execPath, [nodeScript('../node_modules/vite/bin/vite.js'), '--host', '0.0.0.0'], { cwd: root, stdio: 'inherit' });
children.push(worker, vite);
for (const child of children) child.once('exit', (code) => stop(code ?? 1));
