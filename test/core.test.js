import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findDuplicates } from '../src/core.js';

/**
 * Build a disposable directory layout from a spec object. Keys are paths
 * relative to `base`, values are string contents. Directories are created
 * on demand. Centralising this here keeps each test focused on behaviour.
 *
 * @param {string} base
 * @param {Record<string, string>} spec
 */
async function buildTree(base, spec) {
  for (const [rel, content] of Object.entries(spec)) {
    const full = join(base, rel);
    await fs.mkdir(join(base, dirname(rel)), { recursive: true });
    await fs.writeFile(full, content);
  }
}

// Tiny inline dirname to avoid pulling node:path's dirname in a confusing way.
function dirname(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? '.' : p.slice(0, i);
}

async function makeBase() {
  return await fs.mkdtemp(join(tmpdir(), 'dup-test-'));
}

// These tests rely on chmod actually restricting access. When running as
// root (common in CI containers) chmod is a no-op, so skip them.
const isRoot = process.getuid && process.getuid() === 0;
const skipIfRoot = { skip: isRoot ? 'chmod has no effect as root' : undefined };

test('returns empty array for empty roots list', async () => {
  const result = await findDuplicates([]);
  assert.deepEqual(result, []);
});

test('returns empty array when there are no duplicates', async () => {
  const base = await makeBase();
  await buildTree(base, {
    'a.txt': 'alpha',
    'b.txt': 'beta',
    'c.txt': 'gamma',
  });
  const result = await findDuplicates([base]);
  assert.deepEqual(result, []);
});

test('detects two identical files in one tree', async () => {
  const base = await makeBase();
  await buildTree(base, {
    'a.txt': 'same',
    'b.txt': 'same',
  });
  const result = await findDuplicates([base]);
  assert.equal(result.length, 1);
  const group = result[0];
  assert.equal(group.size, 4);
  assert.deepEqual(group.paths, [join(base, 'a.txt'), join(base, 'b.txt')]);
  assert.equal(typeof group.hash, 'string');
  assert.ok(group.hash.length > 0);
});

test('detects duplicates across multiple roots', async () => {
  const a = await makeBase();
  const b = await makeBase();
  await fs.writeFile(join(a, 'x.txt'), 'shared');
  await fs.writeFile(join(b, 'y.txt'), 'shared');
  const result = await findDuplicates([a, b]);
  assert.equal(result.length, 1);
  assert.equal(result[0].paths.length, 2);
  assert.ok(result[0].paths.includes(join(a, 'x.txt')));
  assert.ok(result[0].paths.includes(join(b, 'y.txt')));
});

test('groups by size before hashing: same size but different content is not a duplicate', async () => {
  const base = await makeBase();
  await buildTree(base, {
    'a.txt': 'abcd',
    'b.txt': 'wxyz',
  });
  const result = await findDuplicates([base]);
  assert.deepEqual(result, []);
});

test('handles nested directories', async () => {
  const base = await makeBase();
  await buildTree(base, {
    'top.txt': 'nested',
    'sub/inner.txt': 'nested',
    'sub/deep/again.txt': 'nested',
  });
  const result = await findDuplicates([base]);
  assert.equal(result.length, 1);
  assert.equal(result[0].paths.length, 3);
});

test('ignores empty files even when many exist', async () => {
  const base = await makeBase();
  await buildTree(base, {
    'a.txt': '',
    'b.txt': '',
    'c.txt': '',
  });
  const result = await findDuplicates([base]);
  assert.deepEqual(result, []);
});

test('ignores symlinks to the same file', async () => {
  const base = await makeBase();
  await fs.writeFile(join(base, 'real.txt'), 'content');
  await fs.symlink(join(base, 'real.txt'), join(base, 'link.txt'));
  const result = await findDuplicates([base]);
  assert.deepEqual(result, []);
});

test('skips directories that cannot be read without aborting the scan', skipIfRoot, async () => {
  const base = await makeBase();
  await buildTree(base, {
    'good1.txt': 'same',
    'good2.txt': 'same',
  });
  // A directory the test process cannot list. Assumes POSIX; the test
  // suite is run under Node in a Linux container per the project brief.
  const locked = join(base, 'locked');
  await fs.mkdir(locked);
  await fs.writeFile(join(locked, 'ghost.txt'), 'same');
  await fs.chmod(locked, 0o000);
  try {
    const result = await findDuplicates([base]);
    assert.equal(result.length, 1);
    assert.equal(result[0].paths.length, 2);
  } finally {
    // Restore so cleanup can succeed.
    await fs.chmod(locked, 0o755);
  }
});

test('returns multiple groups and orders them deterministically by size then hash', async () => {
  const base = await makeBase();
  await buildTree(base, {
    'a1.txt': 'aaaa',
    'a2.txt': 'aaaa',
    'bb1.txt': 'bbbbbb',
    'bb2.txt': 'bbbbbb',
  });
  const result = await findDuplicates([base]);
  assert.equal(result.length, 2);
  assert.equal(result[0].size, 4);
  assert.equal(result[1].size, 6);
});

test('paths within a group are sorted for stable output', async () => {
  const base = await makeBase();
  // Build in an order that would not be alphabetical on readdir.
  await fs.writeFile(join(base, 'z.txt'), 'data');
  await fs.writeFile(join(base, 'm.txt'), 'data');
  await fs.writeFile(join(base, 'a.txt'), 'data');
  const result = await findDuplicates([base]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].paths, [
    join(base, 'a.txt'),
    join(base, 'm.txt'),
    join(base, 'z.txt'),
  ]);
});

test('file unreadable after stat is skipped, others still group', skipIfRoot, async () => {
  const base = await makeBase();
  await fs.writeFile(join(base, 'keep1.txt'), 'same');
  await fs.writeFile(join(base, 'keep2.txt'), 'same');
  // We cannot easily make a file stat-able but not readable as a non-root
  // user without chmod, and chmod 0 still lets readFile throw — which is
  // exactly the path we want to exercise.
  const unreadable = join(base, 'unreadable.txt');
  await fs.writeFile(unreadable, 'same');
  await fs.chmod(unreadable, 0o000);
  try {
    const result = await findDuplicates([base]);
    assert.equal(result.length, 1);
    assert.equal(result[0].paths.length, 2);
    assert.ok(!result[0].paths.includes(unreadable));
  } finally {
    await fs.chmod(unreadable, 0o644);
  }
});
