import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import { hashFiles, MANIFEST_NAME } from '../../scripts/pack-extension.mjs';

/**
 * The downloadable extension is a committed artefact, and this is what stops it
 * from rotting.
 *
 * `dashboard/` is the Vercel root, so the extension source one level up is not
 * in the deployment's build context: the zip cannot be produced at deploy time
 * and has to be built here and committed. A committed build of code that lives
 * elsewhere in the same repo is exactly the thing that silently goes stale — the
 * source gets a fix, nobody reruns the packer, and users keep downloading last
 * month's extension with no signal anywhere that they are.
 *
 * So the manifest records a hash per source file, and this compares it against
 * the source as it is now. When it fails the fix is one command:
 * `npm run pack:extension`.
 *
 * Skipped where the source is absent, which is a deployment or a partial
 * checkout — there the committed artefact is all there is, and a test that
 * cannot see the source cannot have an opinion about it.
 */

const SOURCE = resolve(__dirname, '../../../extension');
const MANIFEST = resolve(__dirname, '../../public', MANIFEST_NAME);

describe.runIf(existsSync(SOURCE) && existsSync(MANIFEST))('downloadable extension', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));

  test('the committed package matches the extension source', () => {
    // Compared as whole objects rather than key by key: a file added to the
    // extension and never packed is as stale as a file that changed.
    expect(manifest.files).toEqual(hashFiles(SOURCE));
  });

  test('the manifest states the version the popup will show', () => {
    const source = JSON.parse(readFileSync(resolve(SOURCE, 'manifest.json'), 'utf8'));
    expect(manifest.version).toBe(source.version);
  });
});
