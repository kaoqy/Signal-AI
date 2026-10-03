import { copyFile, access } from 'node:fs/promises';

try {
  await access(new URL('../.dev.vars', import.meta.url));
} catch {
  await copyFile(new URL('../.dev.vars.example', import.meta.url), new URL('../.dev.vars', import.meta.url));
  console.log('Created .dev.vars from the development template. Change its local admin password before using real provider keys.');
}
