// C3 virtual filesystem operations: read/write/move/remove over a
// `VirtualTree`, with all blob IO routed through the C2 `Store` interface.
//
// Every operation returns a **new immutable `VirtualTree`**; the input tree is
// never mutated. These ops produce new trees, **not** persisted snapshots — C4
// wraps a `VirtualTree` into a `Snapshot` and persists it via the store. C3
// never calls `Store.putSnapshot`/`getSnapshot` or constructs `Snapshot`
// records.
//
// Blob IO contract:
//   - `write` creates a `ContentObject` envelope (`kind: 'blob'`) from the
//     content bytes via C1's `createContentObject`, persists it with
//     `Store.putObject`, and records the resulting content `Hash` at the path.
//   - `read` looks up the blob id at the path and fetches the bytes via
//     `Store.getObject`. A missing path raises `PathNotFound`.
//   - `move`/`remove` are pure map operations over the tree — they rebind paths
//     to already-stored blob ids and perform no blob IO. A missing source path
//     raises `PathNotFound`.
//
// No OS file reads or writes happen here; the only IO is through the injected
// `Store`. Directory semantics are path-prefix-only (see `vfs.ts`).

import type { Hash } from "../core/ids.ts";
import { createContentObject } from "../core/object.ts";
import type { ContentObject } from "../core/object.ts";
import type { Store } from "../store/store.ts";
import { makeTree, PathNotFound, type VirtualTree } from "./vfs.ts";

/**
 * Read the content bytes at `path` in `tree`, fetching the stored
 * `ContentObject` through `store.getObject`. Throws `PathNotFound` if `path` is
 * not present in the tree. Returns the payload bytes (the `ContentObject.bytes`
 * for a `kind: 'blob'` envelope).
 */
export function read(
  tree: VirtualTree,
  path: string,
  store: Store,
): Uint8Array {
  const id = tree.entries.get(path);
  if (id === undefined) {
    throw new PathNotFound("read", path);
  }
  const obj = store.getObject(id);
  return obj.bytes;
}

/**
 * Write `bytes` to `path`, producing a new `VirtualTree`. The bytes are wrapped
 * in a `ContentObject` envelope (`kind: 'blob'`), persisted via
 * `store.putObject`, and the resulting content `Hash` is recorded at `path`.
 * If `path` already exists it is overwritten (rebound to the new blob id); the
 * input tree is unchanged.
 */
export async function write(
  tree: VirtualTree,
  path: string,
  bytes: Uint8Array,
  store: Store,
): Promise<VirtualTree> {
  // Copy caller-provided bytes up front: `createContentObject`/`store.putObject`
  // run on an async tick, and a caller-backed `Buffer` (which shares its
  // underlying ArrayBuffer with `bytes`) could be mutated between this call
  // and the await, causing the store to persist bytes that no longer match the
  // blob id we computed. Owning the bytes before any async path closes that
  // aliasing window.
  const owned = new Uint8Array(bytes);
  const obj = await createContentObject("blob", owned);
  store.putObject(obj);
  return setEntry(tree, path, obj.id);
}

/**
 * Move the blob at `from` to `to`, producing a new `VirtualTree`. The blob id
 * is rebound to the destination path; the source path is removed. No blob IO
 * occurs (the blob is already stored). Throws `PathNotFound` if `from` is not
 * present. If `to` already exists it is overwritten with the moved blob id.
 */
export function move(
  tree: VirtualTree,
  from: string,
  to: string,
): VirtualTree {
  const id = tree.entries.get(from);
  if (id === undefined) {
    throw new PathNotFound("move", from);
  }
  // Build the new entry set in one pass: drop `from`, set `to`. Preserves
  // insertion order of all other entries; `to` lands at the end if new.
  const next = new Map<string, Hash>(tree.entries);
  next.delete(from);
  next.set(to, id);
  return makeTree(tree.parentId, next);
}

/**
 * Remove `path` from the tree, producing a new `VirtualTree`. No blob IO
 * occurs (content objects are append-only in the store; removal only drops the
 * path→blob-id binding). Throws `PathNotFound` if `path` is not present.
 */
export function remove(
  tree: VirtualTree,
  path: string,
): VirtualTree {
  if (!tree.entries.has(path)) {
    throw new PathNotFound("remove", path);
  }
  const next = new Map<string, Hash>(tree.entries);
  next.delete(path);
  return makeTree(tree.parentId, next);
}

/** Return the `ContentObject` stored at `path` (via `store.getObject`). */
export function readObject(
  tree: VirtualTree,
  path: string,
  store: Store,
): ContentObject {
  const id = tree.entries.get(path);
  if (id === undefined) {
    throw new PathNotFound("read", path);
  }
  return store.getObject(id);
}

/** Rebind `path` to `id` in a fresh tree, preserving all other entries. */
function setEntry(
  tree: VirtualTree,
  path: string,
  id: Hash,
): VirtualTree {
  const next = new Map<string, Hash>(tree.entries);
  next.set(path, id);
  return makeTree(tree.parentId, next);
}
