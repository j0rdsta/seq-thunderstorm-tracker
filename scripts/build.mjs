/**
 * Builds everything that ships as a single file:
 *
 *   userscripts/overlay  ->  seq-thunderstorm-tracker.user.js            (repo root: @updateURL points here)
 *   userscripts/bridge   ->  seq-thunderstorm-tracker-ha-bridge.user.js
 *   card                 ->  custom_components/seq_thunderstorm_tracker/frontend/seq-thunderstorm-tracker-card.js
 *
 * The userscripts are left unminified with their comments, so people can read what they install.
 * `node scripts/build.mjs --check` fails if a built file in the repo is out of date.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rollup } from 'rollup';
import terser from '@rollup/plugin-terser';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const at = (p) => resolve(root, p);
const pkg = JSON.parse(readFileSync(at('package.json'), 'utf8'));
const check = process.argv.includes('--check');

/** Lets source files `import css from './x.css'` and get the stylesheet as a string. */
const cssAsString = () => ({
  name: 'css-as-string',
  transform(code, id) {
    if (!id.endsWith('.css')) return null;
    return { code: `export default ${JSON.stringify(code)};`, map: { mappings: '' } };
  },
});

/** Replaces __VERSION__ in sources with the version from package.json. */
const version = () => ({
  name: 'version',
  transform(code) {
    return code.includes('__VERSION__')
      ? { code: code.replaceAll('__VERSION__', pkg.version), map: null }
      : null;
  },
});

const header = (file) => readFileSync(at(file), 'utf8').replaceAll('{{version}}', pkg.version);

const targets = [
  {
    input: 'userscripts/overlay/main.js',
    file: 'seq-thunderstorm-tracker.user.js',
    banner: () => header('userscripts/overlay/header.txt'),
  },
  {
    input: 'userscripts/bridge/main.js',
    file: 'seq-thunderstorm-tracker-ha-bridge.user.js',
    banner: () => header('userscripts/bridge/header.txt'),
  },
  {
    input: 'card/src/card.js',
    file: 'custom_components/seq_thunderstorm_tracker/frontend/seq-thunderstorm-tracker-card.js',
    banner: () => `/*! SEQ Thunderstorm Tracker card ${pkg.version} | MIT | https://github.com/j0rdsta/seq-thunderstorm-tracker\n * Bundles Leaflet (BSD-2-Clause, https://leafletjs.com). */`,
    minify: true,
  },
];

let stale = 0;
for (const t of targets) {
  if (!existsSync(at(t.input))) continue;
  const bundle = await rollup({
    input: at(t.input),
    plugins: [cssAsString(), version()],
    onwarn(warning, warn) {
      if (warning.code === 'THIS_IS_UNDEFINED') return;
      warn(warning);
    },
  });
  const { output } = await bundle.generate({
    format: 'iife',
    indent: '  ',
    banner: t.banner(),
    generatedCode: { constBindings: true },
    plugins: t.minify
      ? [terser({ format: { comments: /^!/ }, compress: { passes: 2 } })]
      : [],
  });
  await bundle.close();
  const code = output[0].code.endsWith('\n') ? output[0].code : `${output[0].code}\n`;
  const dest = at(t.file);
  const current = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
  if (check) {
    if (current !== code) { stale++; console.error(`out of date: ${t.file} (run \`npm run build\`)`); }
    continue;
  }
  mkdirSync(dirname(dest), { recursive: true });
  if (current !== code) writeFileSync(dest, code);
  console.log(`${current === code ? 'unchanged' : 'built    '} ${t.file} (${(code.length / 1024).toFixed(1)} kB)`);
}
if (stale) process.exit(1);
