import { readFile, writeFile } from 'node:fs/promises';

for (const [source, target] of [
  ['../src/index.js', '../src/index-source.txt'],
  ['../src/self-update.js', '../src/self-update-source.txt'],
  ['../src/region-icons.js', '../src/region-icons-source.txt'],
  ['../src/entry-probes.js', '../src/entry-probes-source.txt'],
]) {
  await writeFile(new URL(target, import.meta.url), await readFile(new URL(source, import.meta.url)));
}
console.log('Prepared persistent panel updater module sources.');
