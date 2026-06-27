// C7 unit tests: workspace independence (no worktree hijacking).
//
// Two workspaces over the same store/log/bookmarks can check out the same
// snapshot/ref concurrently with no locking. Neither is blocked. Independent
// mutations produce independent snapshots. When the two diverge on the same
// logical ref, a resolvable conflict-as-data object is produced — never a lock
// error.

import { describe, expect, it } from "bun:test";
import type { SnapshotId } from "../../src/core/ids.ts";
import { MemoryStore } from "../../src/store/memory-store.ts";
import {
  createSnapshot,
  loadSnapshot,
  saveSnapshot,
} from "../../src/snapshot/snapshot.ts";
import { Bookmarks } from "../../src/snapshot/bookmark.ts";
import { OpLog } from "../../src/snapshot/oplog.ts";
import { makeTree } from "../../src/vfs/vfs.ts";
import {
  ConflictLog,
  createConflict,
  resolveConflict,
} from "../../src/workspace/conflict.ts";
import {
  Workspace,
  WorkspaceManager,
  asWorkspaceId,
  diverge,
  isWorkspaceId,
} from "../../src/workspace/workspace.ts";
import { write as writePath } from "../../src/vfs/ops.ts";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function dec(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Build and persist a root snapshot with a single file `path` → `content`. */
async function seedSnapshot(
  store: MemoryStore,
  path: string,
  content: string,
  timestamp = 1000,
): Promise<SnapshotId> {
  const tree = makeTree(null);
  const written = await writePath(tree, path, enc(content), store);
  const snap = await createSnapshot(
    null,
    written.entries,
    timestamp,
    "seed",
    false,
  );
  saveSnapshot(snap, store);
  return snap.id;
}

describe("C7 workspace independence", () => {
  it("WorkspaceId is a non-empty branded string", () => {
    const id = asWorkspaceId("ws-1");
    expect(isWorkspaceId(id)).toBe(true);
    expect(isWorkspaceId("")).toBe(false);
    expect(isWorkspaceId(123)).toBe(false);
    expect(() => asWorkspaceId("")).toThrow(TypeError);
  });

  it("two workspaces check out the same snapshot concurrently with no locking", async () => {
    const store = new MemoryStore();
    const log = new OpLog();
    const bookmarks = new Bookmarks(log);
    const manager = new WorkspaceManager(store, log, bookmarks);

    const baseId = await seedSnapshot(store, "shared.txt", "base");
    const base = await loadSnapshot(baseId, store);
    bookmarks.createBookmark("main", baseId);

    const a = await manager.createAtRef("main", { now: () => 2000 });
    const b = await manager.createAtRef("main", { now: () => 3000 });

    // Both checked out the same snapshot/ref; neither blocked the other.
    expect(a.currentSnapshotId).toBe(baseId);
    expect(b.currentSnapshotId).toBe(baseId);
    expect(a.ref).toBe("main");
    expect(b.ref).toBe("main");
    expect(manager.list()).toEqual([a.id, b.id]);
    expect(manager.has(a.id)).toBe(true);
    expect(manager.has(b.id)).toBe(true);
  });

  it("neither workspace is blocked: independent mutations proceed without lock errors", async () => {
    const store = new MemoryStore();
    const log = new OpLog();
    const bookmarks = new Bookmarks(log);
    const manager = new WorkspaceManager(store, log, bookmarks);

    const baseId = await seedSnapshot(store, "shared.txt", "base");
    const base = await loadSnapshot(baseId, store);
    bookmarks.createBookmark("main", baseId);

    const a = await manager.createAtRef("main", { now: () => 2000 });
    const b = await manager.createAtRef("main", { now: () => 3000 });

    // Independent mutations on the same ref — no lock, no error.
    await a.write("a.txt", enc("from-a"));
    await b.write("b.txt", enc("from-b"));

    expect(a.dirty).toBe(true);
    expect(b.dirty).toBe(true);

    const aBoundary = await a.commandBoundary({ timestamp: 2100, message: "a" });
    const bBoundary = await b.commandBoundary({ timestamp: 3100, message: "b" });

    expect(aBoundary).not.toBeNull();
    expect(bBoundary).not.toBeNull();
    expect(aBoundary!.snapshot.id).not.toBe(bBoundary!.snapshot.id);
    expect(a.currentSnapshotId).toBe(aBoundary!.snapshot.id);
    expect(b.currentSnapshotId).toBe(bBoundary!.snapshot.id);

    // Both descend from the shared base, independently.
    expect(aBoundary!.snapshot.parentId).toBe(baseId);
    expect(bBoundary!.snapshot.parentId).toBe(baseId);

    // Each workspace reads its own mutation; no cross-contamination.
    expect(dec(a.read("a.txt"))).toBe("from-a");
    expect(dec(b.read("b.txt"))).toBe("from-b");
    expect(() => a.read("b.txt")).toThrow(); // PathNotFound
    expect(() => b.read("a.txt")).toThrow(); // PathNotFound
  });

  it("divergence on the same ref produces a conflict object, not a lock error", async () => {
    const store = new MemoryStore();
    const log = new OpLog();
    const bookmarks = new Bookmarks(log);
    const manager = new WorkspaceManager(store, log, bookmarks);
    const conflicts = new ConflictLog();

    const baseId = await seedSnapshot(store, "shared.txt", "base");
    bookmarks.createBookmark("main", baseId);

    const a = await manager.createAtRef("main", { now: () => 2000 });
    const b = await manager.createAtRef("main", { now: () => 3000 });

    // Diverge: same base, different mutations.
    await a.write("a.txt", enc("a"));
    await b.write("b.txt", enc("b"));
    await a.commandBoundary({ timestamp: 2100, message: "a" });
    await b.commandBoundary({ timestamp: 3100, message: "b" });

    expect(a.currentSnapshotId).not.toBe(b.currentSnapshotId);

    // Detect divergence — this must not throw and must not block.
    const conflict = await diverge(conflicts, a, b, baseId, 4000);

    expect(conflict).not.toBeNull();
    expect(conflict!.ref).toBe("main");
    expect(conflict!.base).toBe(baseId);
    expect(conflict!.left).toBe(a.currentSnapshotId);
    expect(conflict!.right).toBe(b.currentSnapshotId);
    expect(conflict!.leftWorkspace).toBe(a.id);
    expect(conflict!.rightWorkspace).toBe(b.id);
    expect(conflict!.resolution).toBeNull();
    expect(conflicts.unresolved()).toHaveLength(1);
    expect(conflicts.list()).toHaveLength(1);
  });

  it("no divergence (same head) produces no conflict", async () => {
    const store = new MemoryStore();
    const log = new OpLog();
    const bookmarks = new Bookmarks(log);
    const manager = new WorkspaceManager(store, log, bookmarks);
    const conflicts = new ConflictLog();

    const baseId = await seedSnapshot(store, "shared.txt", "base");
    bookmarks.createBookmark("main", baseId);

    const a = await manager.createAtRef("main");
    const b = await manager.createAtRef("main");

    // No mutations: both heads equal the base.
    const conflict = await diverge(conflicts, a, b, baseId, 5000);
    expect(conflict).toBeNull();
    expect(conflicts.list()).toHaveLength(0);
  });

  it("one-sided advance from the shared base produces no conflict", async () => {
    const store = new MemoryStore();
    const log = new OpLog();
    const bookmarks = new Bookmarks(log);
    const manager = new WorkspaceManager(store, log, bookmarks);
    const conflicts = new ConflictLog();

    const baseId = await seedSnapshot(store, "shared.txt", "base");
    bookmarks.createBookmark("main", baseId);

    const a = await manager.createAtRef("main", { now: () => 2000 });
    const b = await manager.createAtRef("main", { now: () => 3000 });

    await a.write("a.txt", enc("a"));
    const boundary = await a.commandBoundary({ timestamp: 2100, message: "a" });

    expect(boundary).not.toBeNull();
    expect(a.currentSnapshotId).toBe(boundary!.snapshot.id);
    expect(a.currentSnapshotId).not.toBe(baseId);
    expect(b.currentSnapshotId).toBe(baseId);

    const conflict = await diverge(conflicts, a, b, baseId, 4000);

    expect(conflict).toBeNull();
    expect(conflicts.list()).toHaveLength(0);
  });

  it("conflict-as-data is resolvable and resolution is recorded, not thrown", async () => {
    const store = new MemoryStore();
    const log = new OpLog();
    const conflicts = new ConflictLog();

    const baseId = await seedSnapshot(store, "f.txt", "base");
    const leftId = await seedSnapshot(store, "f.txt", "left", 1100);
    const rightId = await seedSnapshot(store, "f.txt", "right", 1200);

    const conflict = await createConflict(
      "main",
      baseId,
      leftId,
      rightId,
      "ws-1",
      "ws-2",
      6000,
    );
    conflicts.record(conflict);
    expect(conflicts.unresolved()).toHaveLength(1);

    // Resolve with a merged snapshot id.
    const mergedId = await seedSnapshot(store, "f.txt", "merged", 7000);
    const resolved = conflicts.resolve(conflict.id, mergedId);

    expect(resolved).toBeDefined();
    expect(resolved!.resolution).toBe(mergedId);
    expect(resolved!.id).toBe(conflict.id); // same logical object
    expect(conflicts.unresolved()).toHaveLength(0);
    expect(conflicts.list()).toHaveLength(1);

    // Recording the same divergence again is idempotent.
    const again = conflicts.record(conflict);
    expect(again.id).toBe(conflict.id);
    expect(conflicts.list()).toHaveLength(1);
  });

  it("explicit Workspace construction tracks ref pointer without locking the ref", async () => {
    const store = new MemoryStore();
    const log = new OpLog();
    const bookmarks = new Bookmarks(log);
    const baseId = await seedSnapshot(store, "x.txt", "base");
    bookmarks.createBookmark("main", baseId);

    const ws = new Workspace(
      store,
      log,
      asWorkspaceId("custom-1"),
      { ref: "main", now: () => 8000 },
      bookmarks,
    );
    expect(ws.id).toBe("custom-1");
    expect(ws.ref).toBe("main");
    expect(ws.currentSnapshotId).toBeNull();

    await ws.checkoutRef("main");
    expect(ws.currentSnapshotId).toBe(baseId);

    // The ref pointer is not ownership: moving the bookmark does not affect the
    // workspace's checked-out snapshot, and the workspace can still mutate.
    bookmarks.moveBookmark("main", await seedSnapshot(store, "y.txt", "other"));
    expect(ws.currentSnapshotId).toBe(baseId); // unchanged — no lock, no auto-move

    await ws.write("new.txt", enc("n"));
    const boundary = await ws.commandBoundary({ timestamp: 8100, message: "w" });
    expect(boundary).not.toBeNull();
    expect(boundary!.snapshot.parentId).toBe(baseId);
  });

  it("manager.createAt checks out the same snapshot for multiple workspaces with no lock", async () => {
    const store = new MemoryStore();
    const log = new OpLog();
    const manager = new WorkspaceManager(store, log);
    const baseId = await seedSnapshot(store, "s.txt", "base");
    const base = await loadSnapshot(baseId, store);

    const a = manager.createAt(base);
    const b = manager.createAt(base);
    const c = manager.createAt(base);

    expect(a.currentSnapshotId).toBe(baseId);
    expect(b.currentSnapshotId).toBe(baseId);
    expect(c.currentSnapshotId).toBe(baseId);
    expect(new Set(manager.list()).size).toBe(3);

    // All can mutate independently; none blocks.
    await a.write("a", enc("a"));
    await b.write("b", enc("b"));
    await c.write("c", enc("c"));
    expect(a.dirty && b.dirty && c.dirty).toBe(true);
  });

  it("checkoutRef on a workspace without a Bookmarks registry throws TypeError, not a lock error", async () => {
    const store = new MemoryStore();
    const log = new OpLog();
    const manager = new WorkspaceManager(store, log); // no bookmarks
    const ws = manager.create();
    await expect(ws.checkoutRef("main")).rejects.toThrow(TypeError);
  });

  it("diverge with a null head produces no conflict (never throws)", async () => {
    const store = new MemoryStore();
    const log = new OpLog();
    const bookmarks = new Bookmarks(log);
    const manager = new WorkspaceManager(store, log, bookmarks);
    const conflicts = new ConflictLog();

    const baseId = await seedSnapshot(store, "f.txt", "base");
    bookmarks.createBookmark("main", baseId);

    const a = manager.create({ ref: "main" }); // not checked out → null head
    const b = await manager.createAtRef("main");

    const conflict = await diverge(conflicts, a, b, baseId, 9000);
    expect(conflict).toBeNull();
    expect(conflicts.list()).toHaveLength(0);
  });

  it("resolveConflict returns a new conflict with the resolution set and id preserved", async () => {
    const baseId = await seedSnapshot(new MemoryStore(), "f.txt", "base");
    const leftId = await seedSnapshot(new MemoryStore(), "f.txt", "left");
    const rightId = await seedSnapshot(new MemoryStore(), "f.txt", "right");
    const conflict = await createConflict(
      "main",
      baseId,
      leftId,
      rightId,
      "ws-1",
      "ws-2",
      10000,
    );
    const mergedId = await seedSnapshot(new MemoryStore(), "f.txt", "merged");
    const resolved = resolveConflict(conflict, mergedId);
    expect(resolved.resolution).toBe(mergedId);
    expect(resolved.id).toBe(conflict.id);
    expect(conflict.resolution).toBeNull(); // original unchanged (immutable)
  });
  it("same divergence recorded at two timestamps yields one ConflictLog entry / same ConflictId", async () => {
    const store = new MemoryStore();
    const conflicts = new ConflictLog();

    const baseId = await seedSnapshot(store, "f.txt", "base");
    const leftId = await seedSnapshot(store, "f.txt", "left", 1100);
    const rightId = await seedSnapshot(store, "f.txt", "right", 1200);

    // Record the same divergence at two different detection times.
    const first = await createConflict(
      "main",
      baseId,
      leftId,
      rightId,
      "ws-1",
      "ws-2",
      6000,
    );
    conflicts.record(first);

    const second = await createConflict(
      "main",
      baseId,
      leftId,
      rightId,
      "ws-1",
      "ws-2",
      9000, // different timestamp, same divergence
    );
    const recordedSecond = conflicts.record(second);

    // The ConflictId is stable across detection times — timestamp is not part
    // of the content-addressed identity.
    expect(second.id).toBe(first.id);
    expect(recordedSecond.id).toBe(first.id);
    expect(conflicts.list()).toHaveLength(1); // one entry, idempotent
    expect(conflicts.unresolved()).toHaveLength(1);

    // The stored record retains the first detection timestamp (insertion wins).
    expect(conflicts.get(first.id)!.timestamp).toBe(6000);
  });
});
