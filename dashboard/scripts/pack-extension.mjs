#!/usr/bin/env node
/**
 * Package `extension/` for download from the dashboard.
 *
 * The dashboard deploys from `dashboard/` as its Vercel root, so the extension
 * source that sits one level up is not in the build context at all: nothing on
 * the deployed site can read it, zip it on the fly, or serve it from disk. The
 * zip therefore has to exist *before* the build, and be committed — which is why
 * this runs as `prebuild` locally and is a no-op on the deployment, where it
 * finds no source and leaves the committed copy alone.
 *
 * Alongside the zip it writes a manifest of file hashes. That is what keeps the
 * committed artefact honest: `extension-package.test.ts` re-hashes the source
 * and fails when the two disagree, so an edit to the extension that never got
 * repacked is caught by the test suite instead of by a user downloading last
 * month's code.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(here, '../../extension');
const PUBLIC = resolve(here, '../public');
export const ZIP_NAME = 'ecom-scraper-extension.zip';
export const MANIFEST_NAME = 'extension-package.json';

/** Every file Chrome needs, in a stable order so the manifest is comparable. */
export function extensionFiles(root = SOURCE) {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      // Editor leftovers and OS noise are not part of the extension.
      if (entry.name === '.DS_Store' || entry.name.endsWith('~')) return [];
      return [relative(root, full)];
    });
  return walk(root).sort();
}

/** `{ path: sha256 }` — the artefact's contents, independent of zip framing. */
export function hashFiles(root = SOURCE) {
  return Object.fromEntries(
    extensionFiles(root).map((file) => [
      file,
      createHash('sha256').update(readFileSync(join(root, file))).digest('hex'),
    ]),
  );
}

function pack() {
  if (!existsSync(SOURCE)) {
    // The deployment case. A missing source is only a failure when there is no
    // committed zip either — then the download link would 404 in production.
    if (existsSync(join(PUBLIC, ZIP_NAME))) {
      console.log(`pack-extension: no ${SOURCE}, keeping the committed ${ZIP_NAME}`);
      return;
    }
    throw new Error(`pack-extension: no extension source at ${SOURCE} and no committed zip`);
  }

  mkdirSync(PUBLIC, { recursive: true });
  const files = extensionFiles();
  const version = JSON.parse(readFileSync(join(SOURCE, 'manifest.json'), 'utf8')).version;

  // `-X` drops the extra attributes that would otherwise make two zips of
  // identical files differ; `-q` keeps the build log about the build.
  execFileSync('zip', ['-qX', join(PUBLIC, ZIP_NAME), ...files], { cwd: SOURCE });

  writeFileSync(
    join(PUBLIC, MANIFEST_NAME),
    `${JSON.stringify({ version, files: hashFiles() }, null, 2)}\n`,
  );
  console.log(`pack-extension: ${ZIP_NAME} v${version}, ${files.length} file(s)`);
}

// Only when run directly: the test imports the helpers above and must not repack.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  pack();
}
