/**
 * Development tool: analyse a tracker image you saved earlier and post it to a Home Assistant
 * webhook, exactly as the bridge userscript would. Handy for trying the integration, the card
 * and your notifications on a quiet day.
 *
 *   node scripts/replay.mjs <saved-tracker.png> <webhook-url> [--issued <ISO time>] [--print]
 *
 * It only reads the file you give it. It never fetches anything from bom.gov.au.
 */

import { readFileSync } from 'node:fs';
import * as core from '../packages/core/index.js';
import { decodePng } from './lib/png.mjs';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, 2)[1]; };
const issuedArg = flag('--issued');
const printOnly = args.includes('--print');
const [file, url] = args.filter((a) => a !== '--print');
if (!file || (!url && !printOnly)) {
  console.error('usage: node scripts/replay.mjs <saved-tracker.png> <webhook-url> [--issued <ISO time>] [--print]');
  process.exit(2);
}

const bytes = readFileSync(file);
const { width, height, data } = decodePng(bytes);
if (width !== core.IMAGE_W || height !== core.IMAGE_H) {
  console.error(`${file} is ${width}×${height}; the tracker image is ${core.IMAGE_W}×${core.IMAGE_H}`);
  process.exit(1);
}
const analysis = core.analyseImage(data, width, height);
const snapshot = core.buildSnapshot({
  issued: issuedArg ? Date.parse(issuedArg) : Date.now(),
  analysis,
  description: 'Replayed from a saved tracker image for testing.',
  png: bytes.toString('base64'),
  source: 'replay-script',
});
console.log(`${analysis.cells.length} storm cells, ${analysis.forecast.length} forecast points, hash ${analysis.hash}`);
if (printOnly) {
  console.log(JSON.stringify({ ...snapshot, image: snapshot.image && { ...snapshot.image, png: `<${snapshot.image.png.length} base64 chars>` } }, null, 2));
} else {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot) });
  console.log(`Home Assistant answered ${res.status}: ${await res.text()}`);
  process.exit(res.ok ? 0 : 1);
}
