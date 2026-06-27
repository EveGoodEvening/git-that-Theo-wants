// C4 unit tests: full Snapshot record and core-state SnapshotId identity.
//
// These tests intentionally stay below C6: manifest refs are opaque `Hash | null`
// attachments only, persisted through Store ManifestRefs and never parsed here.

import { describe, expect, it } from "bun:test";
import type { Hash, SnapshotId } from "../../src/core/ids.ts";
import { asHash, asSnapshotId } from "../../src/core/ids.ts";
import { MemoryStore } from "../../src/store/memory-store.ts";
import {
  computeSnapshotId,
  createSnapshot,
  fromSnapshotEnvelope,
  loadSnapshot,
  parseSnapshotCore,
  saveSnapshot,
  snapshotCoreFraming,
  toSnapshotEnvelope,
  withManifestRefs,
} from "../../src/snapshot/snapshot.ts";
import { makeTree } from "../../src/vfs/vfs.ts";

const BLOB_A = asHash("1".repeat(64));
const BLOB_B = asHash("2".repeat(64));
const BLOB_C = asHash("3".repeat(64));
const REF_PUBLIC_A = asHash("4".repeat(64));
const REF_PRIVATE_A = asHash("5".repeat(64));
const REF_PUBLIC_B = asHash("6".repeat(64));
const REF_PRIVATE_B = asHash("a".repeat(64));
const PARENT_A = asSnapshotId("b".repeat(64));
const PARENT_B = asSnapshotId("c".repeat(64));

const BASE_TREE = new Map<string, Hash>([
  ["src/a.ts", BLOB_A],
  ["src/b.ts", BLOB_B],
]);

function concatTestBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function rawSnapshotCoreFraming(
  parentId: SnapshotId | null,
  entries: ReadonlyArray<readonly [string, Hash]>,
  timestamp: number,
  message: string,
  immutable: boolean,
): Uint8Array {
  const enc = new TextEncoder();
  const messageBytes = enc.encode(message);
  const chunks: Uint8Array[] = [
    enc.encode("snap"),
    new Uint8Array([0]),
    new Uint8Array([0x04, 1, parentId === null ? 0x00 : 0x01]),
  ];
  if (parentId !== null) chunks.push(enc.encode(parentId));
  chunks.push(
    enc.encode(String(timestamp)),
    new Uint8Array([0]),
    enc.encode(String(messageBytes.length)),
    new Uint8Array([0]),
    messageBytes,
    new Uint8Array([immutable ? 0x01 : 0x00]),
  );
  for (const [path, blobId] of entries) {
    const pathBytes = enc.encode(path);
    chunks.push(
      enc.encode(String(pathBytes.length)),
      new Uint8Array([0]),
      pathBytes,
      new Uint8Array([0]),
      enc.encode(blobId),
    );
  }
  return concatTestBytes(chunks);
}

describe("C4 SnapshotId core identity", () => {
  it("computes the id from core state only, independent of tree insertion order and manifest refs", async () => {
    const treeOne = new Map<string, Hash>([
      ["src/b.ts", BLOB_B],
      ["src/a.ts", BLOB_A],
    ]);
    const treeTwo = new Map<string, Hash>([
      ["src/a.ts", BLOB_A],
      ["src/b.ts", BLOB_B],
    ]);

    const first = await createSnapshot(null, treeOne, 10, "message", false, {
      publicManifestRef: REF_PUBLIC_A,
      privateManifestRef: REF_PRIVATE_A,
    });
    const second = await createSnapshot(null, treeTwo, 10, "message", false, {
      publicManifestRef: REF_PUBLIC_B,
      privateManifestRef: REF_PRIVATE_B,
    });

    expect(first.id).toBe(second.id);
    expect(first.publicManifestRef).toBe(REF_PUBLIC_A);
    expect(first.privateManifestRef).toBe(REF_PRIVATE_A);
    expect(second.publicManifestRef).toBe(REF_PUBLIC_B);
    expect(second.privateManifestRef).toBe(REF_PRIVATE_B);
    expect(await computeSnapshotId(null, treeTwo, 10, "message", false)).toBe(first.id);
  });

  it("changes the id when any core field changes, including a path-only rename", async () => {
    const base = await createSnapshot(PARENT_A, BASE_TREE, 20, "base", false);

    const changedParent = await createSnapshot(PARENT_B, BASE_TREE, 20, "base", false);
    const changedBlob = await createSnapshot(
      PARENT_A,
      new Map<string, Hash>([
        ["src/a.ts", BLOB_C],
        ["src/b.ts", BLOB_B],
      ]),
      20,
      "base",
      false,
    );
    const pathOnlyRename = await createSnapshot(
      PARENT_A,
      new Map<string, Hash>([
        ["src/renamed-a.ts", BLOB_A],
        ["src/b.ts", BLOB_B],
      ]),
      20,
      "base",
      false,
    );
    const changedTimestamp = await createSnapshot(PARENT_A, BASE_TREE, 21, "base", false);
    const changedMessage = await createSnapshot(PARENT_A, BASE_TREE, 20, "other", false);
    const changedImmutable = await createSnapshot(PARENT_A, BASE_TREE, 20, "base", true);

    expect(changedParent.id).not.toBe(base.id);
    expect(changedBlob.id).not.toBe(base.id);
    expect(pathOnlyRename.id).not.toBe(base.id);
    expect(changedTimestamp.id).not.toBe(base.id);
    expect(changedMessage.id).not.toBe(base.id);
    expect(changedImmutable.id).not.toBe(base.id);
  });

  it("rejects malformed snapshot id strings at the branded id boundary", () => {
    expect(() => asSnapshotId("not-a-snapshot-id")).toThrow(TypeError);
    expect(() => asSnapshotId("A".repeat(64))).toThrow(TypeError);
    expect(() => asSnapshotId("1".repeat(63))).toThrow(TypeError);
  });

  it("owns caller Map and VirtualTree entries before async hashing resolves", async () => {
    const originalTree = new Map<string, Hash>([
      ["src/a.ts", BLOB_A],
      ["src/b.ts", BLOB_B],
    ]);
    const expectedId = await computeSnapshotId(null, originalTree, 60, "owned", false);
    const expectedBytes = snapshotCoreFraming(null, originalTree, 60, "owned", false);

    const callerMap = new Map<string, Hash>(originalTree);
    const fromMap = createSnapshot(null, callerMap, 60, "owned", false);
    callerMap.set("src/a.ts", BLOB_C);
    callerMap.set("src/late.ts", BLOB_C);
    const mapSnapshot = await fromMap;

    expect(mapSnapshot.id).toBe(expectedId);
    expect(mapSnapshot.tree.get("src/a.ts")).toBe(BLOB_A);
    expect(mapSnapshot.tree.get("src/b.ts")).toBe(BLOB_B);
    expect(mapSnapshot.tree.has("src/late.ts")).toBe(false);
    expect(Array.from(toSnapshotEnvelope(mapSnapshot).serializedBytes)).toEqual(Array.from(expectedBytes));

    const virtualTree = makeTree(null, originalTree);
    const fromVirtualTree = createSnapshot(null, virtualTree, 60, "owned", false);
    const mutableVirtualEntries = virtualTree.entries as Map<string, Hash>;
    mutableVirtualEntries.set("src/a.ts", BLOB_C);
    mutableVirtualEntries.delete("src/b.ts");
    const virtualSnapshot = await fromVirtualTree;

    expect(virtualSnapshot.id).toBe(expectedId);
    expect(virtualSnapshot.tree.get("src/a.ts")).toBe(BLOB_A);
    expect(virtualSnapshot.tree.get("src/b.ts")).toBe(BLOB_B);
    expect(Array.from(toSnapshotEnvelope(virtualSnapshot).serializedBytes)).toEqual(Array.from(expectedBytes));
  });
});

describe("C4 SnapshotEnvelope and manifest-ref attachment", () => {
  it("stores only core bytes in the envelope; withManifestRefs preserves id and bytes", async () => {
    const snapshot = await createSnapshot(null, BASE_TREE, 30, "private metadata", false);
    const before = toSnapshotEnvelope(snapshot);
    const withRefs = withManifestRefs(snapshot, REF_PUBLIC_A, REF_PRIVATE_A);
    const after = toSnapshotEnvelope(withRefs);

    expect(withRefs.id).toBe(snapshot.id);
    expect(Array.from(after.serializedBytes)).toEqual(Array.from(before.serializedBytes));
    const decodedCore = new TextDecoder().decode(after.serializedBytes);
    expect(decodedCore.includes(REF_PUBLIC_A)).toBe(false);
    expect(decodedCore.includes(REF_PRIVATE_A)).toBe(false);

    const parsed = parseSnapshotCore(after.serializedBytes);
    expect(parsed.parentId).toBeNull();
    expect(parsed.timestamp).toBe(30);
    expect(parsed.message).toBe("private metadata");
    expect(parsed.immutable).toBe(false);
    expect(parsed.tree.get("src/a.ts")).toBe(BLOB_A);
  });

  it("save/load round-trips opaque non-null manifest refs through Store ManifestRefs", async () => {
    const store = new MemoryStore();
    const snapshot = await createSnapshot(null, BASE_TREE, 40, "round trip", true, {
      publicManifestRef: REF_PUBLIC_A,
      privateManifestRef: REF_PRIVATE_A,
    });

    saveSnapshot(snapshot, store);
    const envBefore = store.getSnapshot(snapshot.id);
    const loaded = await loadSnapshot(snapshot.id, store);

    expect(loaded.id).toBe(snapshot.id);
    expect(loaded.parentId).toBeNull();
    expect(loaded.publicManifestRef).toBe(REF_PUBLIC_A);
    expect(loaded.privateManifestRef).toBe(REF_PRIVATE_A);
    expect(loaded.tree.get("src/b.ts")).toBe(BLOB_B);

    const changedRefs = withManifestRefs(snapshot, REF_PUBLIC_B, REF_PRIVATE_B);
    saveSnapshot(changedRefs, store);
    const envAfter = store.getSnapshot(snapshot.id);
    const loadedAfterUpsert = await loadSnapshot(snapshot.id, store);

    expect(Array.from(envAfter.serializedBytes)).toEqual(Array.from(envBefore.serializedBytes));
    expect(loadedAfterUpsert.id).toBe(snapshot.id);
    expect(loadedAfterUpsert.publicManifestRef).toBe(REF_PUBLIC_B);
    expect(loadedAfterUpsert.privateManifestRef).toBe(REF_PRIVATE_B);
  });

  it("rejects an envelope whose SnapshotId does not match the core bytes", async () => {
    const snapshot = await createSnapshot(null, BASE_TREE, 50, "valid", false);
    const env = toSnapshotEnvelope(snapshot);
    const badEnv = {
      id: asSnapshotId("f".repeat(64)),
      parentId: env.parentId,
      serializedBytes: env.serializedBytes,
    };

    try {
      await fromSnapshotEnvelope(badEnv, {
        publicManifestRef: null,
        privateManifestRef: null,
      });
      throw new Error("expected invalid SnapshotId rejection");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toContain("Snapshot id mismatch");
    }
  });

  it("rejects non-canonical serialized core bytes that normalize to the same SnapshotId", async () => {
    const snapshot = await createSnapshot(null, BASE_TREE, 70, "canonical", false);
    const cases: Uint8Array[] = [
      rawSnapshotCoreFraming(
        null,
        [
          ["src/b.ts", BLOB_B],
          ["src/a.ts", BLOB_A],
        ],
        70,
        "canonical",
        false,
      ),
      rawSnapshotCoreFraming(
        null,
        [
          ["src/a.ts", BLOB_A],
          ["src/a.ts", BLOB_A],
          ["src/b.ts", BLOB_B],
        ],
        70,
        "canonical",
        false,
      ),
    ];

    for (const serializedBytes of cases) {
      const parsed = parseSnapshotCore(serializedBytes);
      expect(parsed.tree.get("src/a.ts")).toBe(BLOB_A);
      expect(parsed.tree.get("src/b.ts")).toBe(BLOB_B);

      await expect(
        fromSnapshotEnvelope(
          { id: snapshot.id, parentId: snapshot.parentId, serializedBytes },
          { publicManifestRef: null, privateManifestRef: null },
        ),
      ).rejects.toThrow("Snapshot core is not canonical");
    }
  });
});
