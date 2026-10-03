import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const tsc = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
const vite = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));

function run(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: fileURLToPath(root), stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${script} exited with code ${code ?? 'unknown'}`)));
  });
}

await run(tsc, ['-b']);
await run(vite, ['build']);
