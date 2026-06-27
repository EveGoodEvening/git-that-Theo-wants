// C3 virtual filesystem: an immutable path → blob-id view over a snapshot's
// content-addressed blobs.
//
// A `VirtualTree` is *not* a `Snapshot` and C3 never constructs or persists
// `Snapshot` records (that is C4's job). It is the pure, in-memory tree state
// that C4 will wrap into a `Snapshot`: a path → content-`Hash` map plus the
// opaque parent `SnapshotId` (carried unchanged so C4 can compute the snapshot
// identity from `parentId` + canonical tree entries per §2 decision 10).
//
// Directory semantics are simplified to **path-prefix-only** (plan C3
// Blocker/Deferred): paths are opaque strings with no empty-directory tracking
// and no enforced hierarchy. A path is either present (maps to a blob id) or
// absent. `move`/`remove` operate on exact path strings; no directory entries
// are materialized. This is recorded here per the blocker note.
//
// All blob IO (reading bytes back, writing new content) goes through the C2
// `Store` interface in `ops.ts` — this module defines only the immutable value
// and a typed missing-path error, with no IO of its own.

import type { Hash, SnapshotId } from "../core/ids.ts";

/**
 * Immutable virtual filesystem tree: a path → blob-id map plus the parent
 * `SnapshotId` the tree was derived from.
 *
 * `entries` is a `ReadonlyMap` so callers cannot mutate the tree in place; every
 * mutating operation in `ops.ts` returns a *new* `VirtualTree`. `parentId` is
 * `null` for a root tree with no parent. C3 carries `parentId` opaquely and
 * never constructs a `Snapshot` from it.
 */
export interface VirtualTree {
  /** Opaque parent snapshot id, or `null` for a root tree. Carried unchanged. */
  readonly parentId: SnapshotId | null;
  /** Immutable path → content-`Hash` map. Paths are opaque strings. */
  readonly entries: ReadonlyMap<string, Hash>;
}

/**
 * Typed error raised by `read`/`move`/`remove` when the requested path is not
 * present in the tree. Returned instead of `undefined` so callers cannot
 * silently treat a missing path as present-but-empty.
 */
export class PathNotFound extends Error {
  readonly path: string;
  readonly op: "read" | "move" | "remove";

  constructor(
    op: PathNotFound["op"],
    path: string,
    message?: string,
  ) {
    super(message ?? `PathNotFound (${op}): ${path}`);
    this.name = "PathNotFound";
    this.op = op;
    this.path = path;
  }
}

/**
 * Build a `VirtualTree` from an optional parent id and an optional set of
 * entries. The entries are copied into a fresh `Map` so the caller's map cannot
 * mutate the returned tree. Entry order is preserved (insertion order), which
 * keeps tree construction deterministic for callers; canonical ordering for
 * `SnapshotId` computation is C4's responsibility.
 */
export function makeTree(
  parentId: SnapshotId | null,
  entries?: ReadonlyMap<string, Hash> | Iterable<readonly [string, Hash]>,
): VirtualTree {
  const map = entries
    ? entries instanceof Map
      ? new Map<string, Hash>(entries)
      : new Map<string, Hash>(entries)
    : new Map<string, Hash>();
  return { parentId, entries: map };
}

/** An empty root `VirtualTree` with no parent and no entries. */
export function emptyTree(parentId: SnapshotId | null = null): VirtualTree {
  return makeTree(parentId);
}

