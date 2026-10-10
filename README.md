# Dup Finder

A small, focused library that finds duplicate files under one or more directory trees. It groups files by size first and only hashes the contents of groups that contain two or more files of the same size, so it does not read the vast majority of files when duplicates are rare.

## Usage

```js
import { findDuplicates } from 'dup-finder';

const groups = await findDuplicates(['/path/to/dir']);
for (const g of groups) {
  console.log(`${g.size} bytes, ${g.paths.length} copies:`);
  for (const p of g.paths) console.log('  ' + p);
}
```

`findDuplicates(roots: string[]): Promise<DuplicateGroup[]>` where `DuplicateGroup` has `{ size: number, paths: string[], hash: string }`. `paths` is sorted. Groups are sorted by size then by hash.

## Why

The problem is duplicate detection at scale. Hashing every file up front reads every byte on disk; for a large tree that is the dominant cost. Two files can only be byte-for-byte identical if they have the same size, so grouping by size first and hashing only the size-collision buckets turns a full-tree read into a small-fraction read. The trade-off is two `stat` calls per file instead of one read — which is cheap, and lets us skip reading entirely for the common case where file sizes are unique.

The fingerprint used is FNV-1a, not a cryptographic hash. It only needs to distinguish equal-size files cheaply; it is not resisting adversaries.

## Edges you will hit

- Empty files are excluded. There are infinitely many zero-byte files and they are not interesting copies of one another; reporting them as duplicates is noise.
- Symlinks are ignored. A symlink pointing at a file is a link, not a copy, and following it would risk cycles.
- Unreadable directories and files are skipped, not fatal. A permission error on one subtree will not abort the whole scan.
- The scan is synchronous in the sense that it walks one tree at a time; there is no parallelism. This keeps memory bounded and behaviour deterministic.

## Performance

The window keeps a bounded buffer, so `push` is constant time and memory does not
grow with the length of the stream. `peak` and `trough` are linear in the window
size, which is the trade that keeps `push` cheap.

