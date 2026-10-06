/**
 * Turn the printable script PDFs into page images.
 *
 * Discord will not preview a PDF for a player on a phone — it offers a
 * download, which is a file nobody opens in the middle of a game. A PNG is
 * shown inline and zooms on a tap, so the pinned sheets become something the
 * town actually reads rather than something it saves and forgets.
 *
 * This runs once, offline, and its output is committed beside the PDFs:
 * rasterising a 3 MB PDF is far too slow to do while a game is starting, and
 * the sheets only change when a script does.
 *
 *   npm run sheets           re-render every PDF in assets/scripts
 *   npm run sheets -- tb     just one script
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHEET_DIR = path.join(here, '..', 'assets', 'scripts');

// The width the page is rendered at. Discord shows an attachment at about
// 550px wide and lets the reader zoom into the full image, so this is chosen
// for the zoom: small enough to stay well inside the upload limit, large
// enough that the ability text is readable at 100%.
const TARGET_WIDTH = 1600;

async function renderPdf(file) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({
    data: new Uint8Array(fs.readFileSync(file)),
    // No worker thread and no system fonts: this is a build step, and the
    // sheets embed everything they need.
    disableWorker: true,
    isEvalSupported: false,
  }).promise;

  const out = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const unscaled = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: TARGET_WIDTH / unscaled.width });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    // PDFs assume paper. Without this the transparent areas come out black in
    // Discord's dark theme, which is most of the page.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport, canvas }).promise;

    const target = file.replace(/\.pdf$/i, doc.numPages > 1 ? `.p${n}.png` : '.png');
    fs.writeFileSync(target, canvas.toBuffer('image/png'));
    out.push({ target, bytes: fs.statSync(target).size });
  }
  return out;
}

const only = process.argv[2];
const pdfs = fs
  .readdirSync(SHEET_DIR)
  .filter((f) => f.endsWith('.pdf') && (!only || f.startsWith(`${only}.`)))
  .map((f) => path.join(SHEET_DIR, f));

if (!pdfs.length) {
  console.error(`No PDFs to render in ${SHEET_DIR}${only ? ` for "${only}"` : ''}.`);
  process.exit(1);
}

for (const pdf of pdfs) {
  const pages = await renderPdf(pdf);
  for (const { target, bytes } of pages) {
    console.log(`${path.basename(target)}  ${(bytes / 1048576).toFixed(2)} MB`);
  }
}
