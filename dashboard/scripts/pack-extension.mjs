/**
 * Package `extension/` for download from the dashboard.
 *
 * No shebang: `package.json` runs this as `node scripts/pack-extension.mjs`, so
 * the line was decorative — and `extension-package.test.ts` imports this file,
 * where on Windows the loader hands it to a parser that reads the leading `#` as
 * `SyntaxError: Invalid or unexpected token` and fails the suite before a single
 * test runs.
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
import { deflateRawSync, crc32 } from 'node:zlib';
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

/**
 * Write a zip, without a `zip` binary.
 *
 * This used to shell out to `zip -qX`, which is not on a stock Windows machine
 * and made `npm run pack:extension` — and with it `npm run build`, which runs it
 * as `prebuild` — fail there with `spawnSync zip ENOENT`.
 *
 * Deterministic on purpose, and more so than `-X` was: every entry is stamped
 * with the same fixed DOS timestamp, so packing unchanged sources twice produces
 * byte-identical zips. The artefact is committed, and a zip that differed on
 * every pack would show up as a diff in every branch that touched the extension.
 *
 * Deflate, stored in one shot rather than streamed: the whole extension is a
 * few tens of kilobytes.
 */
function writeZip(target, root, files) {
  // 1980-01-01 00:00:00, the earliest a DOS timestamp can express.
  const DOS_TIME = 0;
  const DOS_DATE = 33;

  const locals = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.split('\\').join('/'), 'utf8');
    const contents = readFileSync(join(root, file));
    const deflated = deflateRawSync(contents, { level: 9 });
    // A file that deflates larger than it started — already-compressed bytes —
    // is stored instead. Method 0 and method 8 are both universally readable.
    const stored = deflated.length >= contents.length;
    const body = stored ? contents : deflated;
    const crc = crc32(contents);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(stored ? 0 : 8, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(contents.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(0, 42); // local header offset, filled below
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += local.length + name.length + body.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  writeFileSync(target, Buffer.concat([...locals, directory, end]));
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

  // Rewritten from scratch every time rather than updated in place: `zip` used
  // to append, which meant a file deleted from the extension stayed in the
  // downloadable copy until someone removed the zip by hand.
  writeZip(join(PUBLIC, ZIP_NAME), SOURCE, files);

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
