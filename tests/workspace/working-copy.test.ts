// C4 unit tests: JJ-style working-copy-as-snapshot.
//
// A working copy has no index/staging area and no current branch. Mutations update
// the in-memory tree, then the command boundary auto-creates a snapshot with null
// manifest refs and records a snapshot-create op-log event.

import { describe, expect, it } from "bun:test";
import type { SnapshotId } from "../../src/core/ids.ts";
import { MemoryStore } from "../../src/store/memory-store.ts";
import { loadSnapshot } from "../../src/snapshot/snapshot.ts";
import { OpLog } from "../../src/snapshot/oplog.ts";
import { WorkingCopy, createWorkingCopy } from "../../src/workspace/working-copy.ts";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function dec(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe("C4 working-copy-as-snapshot", () => {
  it("auto-snapshots a dirty working copy on a no-op command boundary", async () => {
    const store = new MemoryStore();
    const log = new OpLog();
    const wc = createWorkingCopy(store, log, { now: () => 100 });

    await wc.write("hello.txt", enc("hello"));
    expect(wc.dirty).toBe(true);
    expect(store.listSnapshots()).toEqual([]);

    const result = await wc.runCommand(() => "no-op", { message: "auto" });

    expect(result.result).toBe("no-op");
    expect(result.boundary).not.toBeNull();
    const snapshot = result.boundary!.snapshot;
    expect(snapshot.parentId).toBeNull();
    expect(snapshot.timestamp).toBe(100);
    expect(snapshot.message).toBe("auto");
    expect(snapshot.immutable).toBe(false);
    expect(snapshot.publicManifestRef).toBeNull();
    expect(snapshot.privateManifestRef).toBeNull();
    expect(wc.currentSnapshotId).toBe(snapshot.id);
    expect(wc.dirty).toBe(false);
    expect(store.listSnapshots()).toEqual([snapshot.id]);
    expect(store.getManifestRefs(snapshot.id)).toEqual({
      publicManifestRef: null,
      privateManifestRef: null,
    });

    const loaded = await loadSnapshot(snapshot.id, store);
    expect(loaded.id).toBe(snapshot.id);
    expect(loaded.publicManifestRef).toBeNull();
    expect(loaded.privateManifestRef).toBeNull();
    expect(dec(wc.read("hello.txt"))).toBe("hello");
  });

  it("records auto-snapshot creation in the op-log", async () => {
    const store = new MemoryStore();
    const log = new OpLog();
    const wc = createWorkingCopy(store, log);

    await wc.write("a.txt", enc("A"));
    const boundary = await wc.commandBoundary({ timestamp: 200, message: "first" });

    expect(boundary).not.toBeNull();
    expect(boundary!.event.kind).toBe("snapshot-create");
    expect(boundary!.event.seq).toBe(1);
    expect(boundary!.event.timestamp).toBe(200);
    expect(boundary!.event.snapshotId).toBe(boundary!.snapshot.id);
    expect(boundary!.event.parentId).toBeNull();
    expect(log.list()).toEqual([boundary!.event]);
  });

  it("does not create a snapshot for a clean command boundary", async () => {
    const store = new MemoryStore();
    const log = new OpLog();
    const wc = createWorkingCopy(store, log);

    const cleanBoundary = await wc.runCommand(() => undefined, { timestamp: 300 });

    expect(cleanBoundary.boundary).toBeNull();
    expect(store.listSnapshots()).toEqual([]);
    expect(log.length).toBe(0);
    expect(wc.currentSnapshotId).toBeNull();
  });

  it("has direct mutations only: no index and no current branch surface", async () => {
    const store = new MemoryStore();
    const log = new OpLog();
    const wc = createWorkingCopy(store, log);
    const exposed = wc as unknown as Record<string, unknown>;

    expect("index" in exposed).toBe(false);
    expect("stagingArea" in exposed).toBe(false);
    expect("currentBranch" in exposed).toBe(false);
    expect("branch" in exposed).toBe(false);

    await wc.write("a.txt", enc("A"));
    wc.move("a.txt", "b.txt");
    expect(dec(wc.read("b.txt"))).toBe("A");
    expect(store.listSnapshots()).toEqual([]);

    const boundary = await wc.commandBoundary({ timestamp: 400, message: "after direct mutations" });
    expect(boundary).not.toBeNull();
    expect(store.listSnapshots()).toEqual([boundary!.snapshot.id]);
  });

  it("chains snapshots by using the previous working-copy snapshot as parent", async () => {
    const store = new MemoryStore();
    const log = new OpLog();
    const wc = new WorkingCopy(store, log);

    await wc.write("a.txt", enc("A"));
    const first = await wc.commandBoundary({ timestamp: 500, message: "first" });
    expect(first).not.toBeNull();

    await wc.write("b.txt", enc("B"));
    const second = await wc.commandBoundary({ timestamp: 501, message: "second", immutable: true });
    expect(second).not.toBeNull();

    const firstId: SnapshotId = first!.snapshot.id;
    expect(second!.snapshot.parentId).toBe(firstId);
    expect(second!.snapshot.immutable).toBe(true);
    expect(second!.event.parentId).toBe(firstId);
    expect(store.listSnapshots()).toEqual([firstId, second!.snapshot.id]);

    const reloaded = await WorkingCopy.load(store, log, second!.snapshot.id);
    expect(reloaded.currentSnapshotId).toBe(second!.snapshot.id);
    expect(reloaded.dirty).toBe(false);
    expect(dec(reloaded.read("a.txt"))).toBe("A");
    expect(dec(reloaded.read("b.txt"))).toBe("B");
  });
});
