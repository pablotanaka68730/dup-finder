import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/**
 * A group of two or more byte-for-byte identical files.
 * `size` is recorded once per group so callers can compute wasted space
 * as `(group.paths.length - 1) * group.size` without re-statting anything.
 */
export class DuplicateGroup {
  /** @type {number} */
  size;
  /** @type {string[]} */
  paths;
  /** @type {string} */
  hash;

  /**
   * @param {object} args
   * @param {number} args.size
   * @param {string[]} args.paths
   * @param {string} args.hash
   */
  constructor({ size, paths, hash }) {
    this.size = size;
    this.paths = paths;
    this.hash = hash;
  }
}

/**
 * Walks a directory tree and collects regular files only. We deliberately
 * ignore symlinks (`withFileTypes` + `isSymbolicLink`) because a symlink
 * pointing at the same file is not, itself, a duplicate copy — it is a link.
 * Following links here could also create cycles.
 *
 * Errors encountered while reading an individual entry (e.g. a directory
 * that vanishes between `readdir` and `stat`, or a permission error on one
 * subtree) are swallowed and that entry is skipped, so one broken subtree
 * does not abort the whole scan.
 *
 * `roots` is kept as the plural so callers can pass `['/a', '/b']` and find
 * duplicates that span both trees.
 *
 * @param {string[]} roots
 * @returns {Promise<Array<{ path: string, size: number }>>}
 */
async function collectFiles(roots) {
  /** @type {Array<{ path: string, size: number }>} */
  const files = [];
  const stack = [...roots];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      // Directory unreadable (permissions, removed mid-scan, not a dir, …).
      // Skip it and continue with whatever else is on the stack.
      continue;
    }

    for (const entry of entries) {
      // Use entry.name (just the base name) joined to dir. On Windows this
      // still yields a usable path; we never call entry.path which is
      // platform-specific and not in older Node versions.
      const full = join(dir, entry.name);

      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }

      if (!entry.isFile()) {
        // FIFOs, sockets, block devices, etc. None of these are useful as
        // "files" for duplicate detection; reading them would hang or fail.
        continue;
      }

      // Stat to get size. `entry.isFile()` tells us it is a file, but the
      // `Dirent` does not carry a size, so a separate stat is unavoidable.
      try {
        const stat = await fs.stat(full);
        files.push({ path: full, size: stat.size });
      } catch {
        // File removed between readdir and stat, or permissions dropped.
        continue;
      }
    }
  }

  return files;
}

/**
 * A small synchronous, non-cryptographic fingerprint. The goal here is purely
 * to distinguish files of equal size cheaply — not to resist adversarial
 * collisions. SHA-256 would be overkill and slower; this is enough.
 *
 * The algorithm mirrors FNV-1a 32-bit. It is deterministic across runs and
 * platforms, which is the only property we need. We expose the hash on the
 * returned `DuplicateGroup` purely as a stable group identifier.
 *
 * @param {Buffer} buf
 * @returns {string}
 */
function fingerprint(buf) {
  // FNV-1a 32-bit constants.
  let hash = 0x811c9dc5;
  for (let i = 0; i < buf.length; i++) {
    hash ^= buf[i];
      // The `>>> 0` forces unsigned 32-bit semantics so the bitwise ops
      // behave the same on every platform and never drift into a negative
      // 64-bit float representation.
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Find duplicate files under one or more root directories.
 *
 * Strategy: walk the tree, group files by size, and only hash the contents
 * of groups that contain two or more files of the same size. This avoids
 * reading the vast majority of files when duplicates are rare, and is the
 * whole reason this library exists rather than calling `sha256` on
 * everything blindly.
 *
 * Empty files (size 0) are intentionally excluded from the result. There
 * are infinitely many zero-byte files and they are not interesting copies
 * of one another; reporting every empty file as a duplicate is noise.
 *
 * @param {string[]} roots
 * @returns {Promise<DuplicateGroup[]>}
 */
export async function findDuplicates(roots) {
  if (!Array.isArray(roots) || roots.length === 0) {
    return [];
  }

  const files = await collectFiles(roots);

  // Group by size first. Only groups with >1 file of the same size justify
  // the cost of reading bytes.
  /** @type {Map<number, Array<{ path: string, size: number }>>} */
  const bySize = new Map();
  for (const f of files) {
    if (f.size === 0) continue; // skip empty files deliberately
    let bucket = bySize.get(f.size);
    if (bucket === undefined) {
      bucket = [];
      bySize.set(f.size, bucket);
    }
    bucket.push(f);
  }

  /** @type {Map<string, { size: number, paths: string[] }>} */
  const byHash = new Map();

  for (const bucket of bySize.values()) {
    if (bucket.length < 2) continue;

    for (const f of bucket) {
      let buf;
      try {
        buf = await fs.readFile(f.path);
      } catch {
        // File became unreadable after stat. Drop it; we can't verify it.
        continue;
      }
      const h = fingerprint(buf);
      let g = byHash.get(h);
      if (g === undefined) {
        g = { size: f.size, paths: [] };
        byHash.set(h, g);
      }
      g.paths.push(f.path);
    }
  }

  /** @type {DuplicateGroup[]} */
  const groups = [];
  for (const [hash, g] of byHash) {
    if (g.paths.length < 2) continue;
    // Sort for deterministic output. Tests rely on a stable order, and
    // so will anyone diffing two scans.
    g.paths.sort();
    groups.push(new DuplicateGroup({ size: g.size, paths: g.paths, hash }));
  }

  // Sort by size then by hash so output is stable and easy to scan.
  groups.sort((a, b) =>
    a.size !== b.size ? a.size - b.size : a.hash.localeCompare(b.hash)
  );

  return groups;
}
