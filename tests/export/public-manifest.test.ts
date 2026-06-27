// C6 public manifest and public export bundle tests.
//
// Covers (plan C6 checklist):
//   - PublicManifest schema + deterministic self-hash (field omitted/null).
//   - Metadata absence: zero private bytes, paths, blob/secret ids, manifest
//     refs, sizes, timestamps, op-log entries, messages, and zero full
//     SnapshotId values (only PublicProjectionIds appear).
//   - Public projection determinism + private-history elision: identical public
//     entries with different private-only history -> identical projection ids,
//     identical public manifests, identical bundle hashes.
//   - The `public A -> private-only P -> public B` (same public entries as A)
//     parent-leak case matches no-private-history `public A -> public B'`: B
//     reuses A's PublicProjectionId.
//   - Bundle integrity passes/fails correctly.
//   - Manifest refs written via Snapshot.withManifestRefs + Store.putManifestRefs
//     (acyclic manifest-ref mapping; SnapshotId unchanged).

import { describe, expect, it } from "bun:test";
import { MemoryStore } from "../../src/store/memory-store.ts";
import type { Store } from "../../src/store/store.ts";
import { createContentObject } from "../../src/core/object.ts";
import { asHash, type Hash, type SnapshotId } from "../../src/core/ids.ts";
import {
  createSnapshot,
  saveSnapshot,
  loadSnapshot,
  toSnapshotEnvelope,
  type Snapshot,
} from "../../src/snapshot/snapshot.ts";
import { makeTree } from "../../src/vfs/vfs.ts";
import {
  type PublicEntry,
  type PublicExportBundle,
  type SnapshotVisibility,
  attachManifestRefs,
  buildAndAttachManifests,
  buildPublicExportBundle,
  buildPublicManifest,
  canonicalPublicEntries,
  computePublicManifestHash,
  derivePublicProjection,
  parsePublicManifest,
  publicEntriesOf,
  serializePublicManifest,
  verifyPublicExportBundle,
  verifyPublicManifest,
} from "../../src/export/public-manifest.ts";
import { asPublicProjectionId } from "../../src/policy/private-manifest.ts";
import { Denied } from "../../src/policy/visibility.ts";

const enc = new TextEncoder();

/** Put a plain blob into the store and return its content `Hash`. */
async function putBlob(store: Store, content: string): Promise<Hash> {
  const obj = await createContentObject("blob", enc.encode(content));
  store.putObject(obj);
  return obj.id;
}

async function realSnap(
  store: Store,
  parent: SnapshotId | null,
  entries: Iterable<readonly [string, Hash]>,
  timestamp: number,
  message: string,
  immutable = false,
): Promise<Snapshot> {
  const tree = makeTree(parent, new Map(entries));
  const s = await createSnapshot(parent, tree, timestamp, message, immutable);
  saveSnapshot(s, store);
  return s;
}

describe("C6 PublicManifest schema and deterministic self-hash", () => {
  it("buildPublicManifest computes a deterministic self-hash with the field omitted", async () => {
    const entries: PublicEntry[] = [
      { path: "a.txt", blobId: await putBlob(new MemoryStore(), "a") },
    ];
    const m = await buildPublicManifest([], entries);
    // The hash is a valid 64-char hex.
    expect(m.publicManifestHash.length).toBe(64);
    // Recompute over the payload (field omitted) and compare.
    const payload = {
      bundleVersion: m.bundleVersion,
      publicProjectionIds: m.publicProjectionIds,
      publicEntries: m.publicEntries,
    };
    const recomputed = await computePublicManifestHash(payload);
    expect(recomputed).toBe(m.publicManifestHash);
  });

  it("verifyPublicManifest accepts a valid manifest", async () => {
    const m = await buildPublicManifest([], [
      { path: "a.txt", blobId: asHash("a".repeat(64)) },
    ]);
    expect(await verifyPublicManifest(m)).toBe(true);
  });

  it("verifyPublicManifest rejects a tampered hash", async () => {
    const m = await buildPublicManifest([], [
      { path: "a.txt", blobId: asHash("a".repeat(64)) },
    ]);
    const tampered = {
      ...m,
      publicManifestHash: asHash("b".repeat(64)),
    };
    expect(await verifyPublicManifest(tampered)).toBe(false);
  });

  it("is deterministic: identical entries+ids -> identical manifest+hash", async () => {
    const blobId = asHash("a".repeat(64));
    const a = await buildPublicManifest([], [{ path: "a.txt", blobId }]);
    const b = await buildPublicManifest([], [{ path: "a.txt", blobId }]);
    expect(a.publicManifestHash).toBe(b.publicManifestHash);
    expect(canonicalPublicEntries(a.publicEntries)).toEqual(
      canonicalPublicEntries(b.publicEntries),
    );
  });

  it("serialize/parse round-trips and verifies", async () => {
    const blobId = asHash("a".repeat(64));
    const projId = asPublicProjectionId("1".repeat(64));
    const m = await buildPublicManifest([projId], [
      { path: "a.txt", blobId },
      { path: "z.txt", blobId },
    ]);
    const bytes = serializePublicManifest(m);
    const parsed = await parsePublicManifest(bytes);
    expect(parsed.publicManifestHash).toBe(m.publicManifestHash);
    expect(parsed.publicEntries).toEqual(m.publicEntries);
    expect(parsed.publicProjectionIds).toEqual(m.publicProjectionIds);
    expect(await verifyPublicManifest(parsed)).toBe(true);
  });

  it("serializes public entry path lengths as UTF-8 byte lengths", async () => {
    const blobId = asHash("a".repeat(64));
    const m = await buildPublicManifest([], [{ path: "é.txt", blobId }]);
    const parsed = await parsePublicManifest(serializePublicManifest(m));
    expect(parsed.publicEntries).toEqual([{ path: "é.txt", blobId }]);
    expect(await verifyPublicManifest(parsed)).toBe(true);
  });

  it("parse rejects a hash mismatch (truncated/tampered)", async () => {
    const blobId = asHash("a".repeat(64));
    const m = await buildPublicManifest([], [{ path: "a.txt", blobId }]);
    const bytes = serializePublicManifest(m);
    // Flip the last byte of the hash.
    const tampered = new Uint8Array(bytes);
    tampered[tampered.length - 1] = tampered[tampered.length - 1] === 0x30
      ? 0x31
      : 0x30;
    await expect(parsePublicManifest(tampered)).rejects.toThrow();
  });
});

describe("C6 public projection determinism + private-history elision", () => {
  it("identical public entries + different private-only history -> identical projection ids", async () => {
    const store = new MemoryStore();
    const pubBlob = await putBlob(store, "public");
    // A: public snapshot with one public file.
    const a = await realSnap(store, null, [["pub.txt", pubBlob]], 10, "A public");
    // P: private-only snapshot (different private file, same public file).
    const privBlob = await putBlob(store, "private");
    const p = await realSnap(store, a.id, [["pub.txt", pubBlob], ["secret.txt", privBlob]], 20, "P private");
    // B: public snapshot, same public entries as A, descended from P.
    const b = await realSnap(store, p.id, [["pub.txt", pubBlob]], 30, "B public");

    const vis = new Map<SnapshotId, SnapshotVisibility>([
      [a.id, { state: "public" }],
      [p.id, { state: "private" }],
      [b.id, { state: "public" }],
    ]);
    const chain = [a, p, b];
    const { nodes, projectionBySnapshot } = await derivePublicProjection(chain, vis);

    // P is elided (private-only); A mints a node, B is a public-noop that
    // reuses A's projection id (no new node).
    expect(nodes.length).toBe(1);
    // B reuses A's projection id (same public entries, same public-visible
    // parent). This is the parent-leak case: B does not leak P.
    expect(projectionBySnapshot.get(b.id)).toBe(projectionBySnapshot.get(a.id));
  });

  it("public A -> public B' (no private history) with same public entries -> B' reuses A's id", async () => {
    const store = new MemoryStore();
    const pubBlob = await putBlob(store, "public");
    const a = await realSnap(store, null, [["pub.txt", pubBlob]], 10, "A");
    const bPrime = await realSnap(store, a.id, [["pub.txt", pubBlob]], 20, "B'");

    const vis = new Map<SnapshotId, SnapshotVisibility>([
      [a.id, { state: "public" }],
      [bPrime.id, { state: "public" }],
    ]);
    const { nodes, projectionBySnapshot } = await derivePublicProjection(
      [a, bPrime],
      vis,
    );
    // B' is a public-noop relative to A: reuses A's projection id.
    expect(projectionBySnapshot.get(bPrime.id)).toBe(
      projectionBySnapshot.get(a.id),
    );
    expect(nodes.length).toBe(1);
  });

  it("uses parentId, not iteration order, for nearest public-visible ancestors", async () => {
    const store = new MemoryStore();
    const blobA = await putBlob(store, "a");
    const blobB = await putBlob(store, "b");
    const blobC = await putBlob(store, "c");
    const a = await realSnap(store, null, [["a.txt", blobA]], 10, "A");
    const c = await realSnap(store, null, [["c.txt", blobC]], 11, "C unrelated");
    const b = await realSnap(store, a.id, [["b.txt", blobB]], 12, "B child of A");
    const vis = new Map<SnapshotId, SnapshotVisibility>([
      [a.id, { state: "public" }],
      [c.id, { state: "public" }],
      [b.id, { state: "public" }],
    ]);
    const { nodes, projectionBySnapshot } = await derivePublicProjection(
      [a, c, b],
      vis,
    );
    const aProjection = projectionBySnapshot.get(a.id);
    const bProjection = projectionBySnapshot.get(b.id);
    expect(aProjection).toBeDefined();
    expect(bProjection).toBeDefined();
    const bNode = nodes.find((n) => n.projectionId === bProjection);
    expect(bNode?.parentProjectionIds).toEqual([aProjection]);
  });

  it("different public entries -> different projection ids", async () => {
    const store = new MemoryStore();
    const blob1 = await putBlob(store, "one");
    const blob2 = await putBlob(store, "two");
    const a = await realSnap(store, null, [["a.txt", blob1]], 10, "A");
    const b = await realSnap(store, a.id, [["a.txt", blob2]], 20, "B");

    const vis = new Map<SnapshotId, SnapshotVisibility>([
      [a.id, { state: "public" }],
      [b.id, { state: "public" }],
    ]);
    const { projectionBySnapshot } = await derivePublicProjection([a, b], vis);
    expect(projectionBySnapshot.get(a.id)).not.toBe(
      projectionBySnapshot.get(b.id),
    );
  });

  it("identical public entries + different private-only history -> identical bundle hashes", async () => {
    const store = new MemoryStore();
    const pubBlob = await putBlob(store, "public");
    const privBlob = await putBlob(store, "private");

    // Chain 1: A(public) -> B(public), same public entries.
    const a1 = await realSnap(store, null, [["pub.txt", pubBlob]], 10, "A");
    const b1 = await realSnap(store, a1.id, [["pub.txt", pubBlob]], 20, "B");
    const vis1 = new Map<SnapshotId, SnapshotVisibility>([
      [a1.id, { state: "public" }],
      [b1.id, { state: "public" }],
    ]);
    const r1 = await derivePublicProjection([a1, b1], vis1);
    const bundle1 = await buildPublicExportBundle(r1.nodes, store);

    // Chain 2: A(public) -> P(private-only) -> B(public), same public entries.
    const a2 = await realSnap(store, null, [["pub.txt", pubBlob]], 10, "A");
    const p2 = await realSnap(
      store,
      a2.id,
      [["pub.txt", pubBlob], ["secret.txt", privBlob]],
      15,
      "P",
    );
    const b2 = await realSnap(store, p2.id, [["pub.txt", pubBlob]], 20, "B");
    const vis2 = new Map<SnapshotId, SnapshotVisibility>([
      [a2.id, { state: "public" }],
      [p2.id, { state: "private" }],
      [b2.id, { state: "public" }],
    ]);
    const r2 = await derivePublicProjection([a2, p2, b2], vis2);
    const bundle2 = await buildPublicExportBundle(r2.nodes, store);

    expect(bundle1.manifest.publicManifestHash).toBe(
      bundle2.manifest.publicManifestHash,
    );
  });
});

describe("C6 metadata absence in public export", () => {
  it("public bundle contains zero private bytes, paths, blob/secret ids, manifest refs, sizes, timestamps, op-log entries, messages, and zero full SnapshotId values", async () => {
    const store = new MemoryStore();
    const pubBlob = await putBlob(store, "public-content");
    const privBlob = await putBlob(store, "top-secret-private-content");
    const secretObj = await createContentObject(
      "secret-blob",
      enc.encode("top-secret-private-ciphertext"),
    );
    store.putObject(secretObj);
    const PRIVATE_PATH = "secret/path.txt";
    const PRIVATE_MSG = "private commit message with secrets";

    const a = await realSnap(store, null, [["pub.txt", pubBlob]], 111111, "public A");
    const p = await realSnap(
      store,
      a.id,
      [["pub.txt", pubBlob], [PRIVATE_PATH, privBlob], ["secret/blob.bin", secretObj.id]],
      222222,
      PRIVATE_MSG,
    );
    const b = await realSnap(store, p.id, [["pub.txt", pubBlob]], 333333, "public B");

    const vis = new Map<SnapshotId, SnapshotVisibility>([
      [a.id, { state: "public" }],
      [p.id, { state: "private" }],
      [b.id, { state: "public" }],
    ]);
    const { nodes } = await derivePublicProjection([a, p, b], vis);
    const bundle = await buildPublicExportBundle(nodes, store);
    const serialized = serializePublicManifest(bundle.manifest);
    const serializedStr = new TextDecoder().decode(serialized);

    // No private path strings.
    expect(serializedStr).not.toContain("secret");
    expect(serializedStr).not.toContain(PRIVATE_PATH);
    // No private message strings.
    expect(serializedStr).not.toContain(PRIVATE_MSG);
    // No timestamps (111111, 222222, 333333 do not appear).
    expect(serializedStr).not.toContain("111111");
    expect(serializedStr).not.toContain("222222");
    expect(serializedStr).not.toContain("333333");
    // No full SnapshotId values: the snapshot ids are 64-char hex strings; none
    // of the three snapshot ids appear in the bundle. (Projection ids are also
    // 64-char hex but are different values.)
    const snapIds = [a.id, p.id, b.id];
    for (const id of snapIds) {
      expect(serializedStr).not.toContain(id);
    }
    // No private blob ids: the private blob's content hash must not appear.
    expect(serializedStr).not.toContain(privBlob);
    // No private secret-blob ids.
    expect(serializedStr).not.toContain(secretObj.id);
    // No "manifestRef" / "op-log" / "message" / "timestamp" field labels.
    expect(serializedStr).not.toContain("manifestRef");
    expect(serializedStr).not.toContain("op-log");
    expect(serializedStr).not.toContain("message");
    expect(serializedStr).not.toContain("timestamp");
    // No sizes: the bundle carries only {path, blobId} entries, no size field.
    expect(serializedStr).not.toContain("size");

    // The bundle's objects map contains only the public blob, not the private
    // blob.
    expect(bundle.objects.has(pubBlob)).toBe(true);
    expect(bundle.objects.has(privBlob)).toBe(false);
    expect(bundle.objects.has(secretObj.id)).toBe(false);
    // The public blob's bytes are the public content; the private blob's bytes
    // are absent.
    const pubObj = bundle.objects.get(pubBlob);
    expect(pubObj).toBeDefined();
    expect(new TextDecoder().decode(pubObj!.bytes)).toBe("public-content");
  });

  it("publicEntriesOf omits non-public paths even when the snapshot is public (file-level visibility)", async () => {
    const store = new MemoryStore();
    const pubBlob = await putBlob(store, "pub");
    const privBlob = await putBlob(store, "priv");
    const s = await realSnap(
      store,
      null,
      [["pub.txt", pubBlob], ["priv.txt", privBlob]],
      10,
      "mixed",
    );
    const vis: SnapshotVisibility = {
      state: "public",
      pathStates: new Map([["priv.txt", "private"]]),
    };
    const entries = publicEntriesOf(s, vis);
    expect(entries.map((e) => e.path)).toEqual(["pub.txt"]);
  });

  it("a non-public snapshot contributes no public entries (private/embargoed omitted; local-only rejected)", async () => {
    const store = new MemoryStore();
    const blob = await putBlob(store, "x");
    const s = await realSnap(store, null, [["x.txt", blob]], 10, "private");
    // private/embargoed are omitted (exportable states with no public entries).
    expect(publicEntriesOf(s, { state: "private" })).toEqual([]);
    expect(publicEntriesOf(s, { state: "embargoed" })).toEqual([]);
    // local-only is rejected, not omitted: it must never be silently stripped.
    expect(() => publicEntriesOf(s, { state: "local-only" })).toThrow(Denied);
  });
});

describe("C6 bundle integrity", () => {
  it("verifyPublicExportBundle accepts an intact bundle", async () => {
    const store = new MemoryStore();
    const blob = await putBlob(store, "content");
    const a = await realSnap(store, null, [["a.txt", blob]], 10, "A");
    const { nodes } = await derivePublicProjection(
      [a],
      new Map([[a.id, { state: "public" }]]),
    );
    const bundle = await buildPublicExportBundle(nodes, store);
    expect(await verifyPublicExportBundle(bundle)).toBe(true);
  });

  it("verifyPublicExportBundle rejects a bundle with a missing object", async () => {
    const store = new MemoryStore();
    const blob = await putBlob(store, "content");
    const a = await realSnap(store, null, [["a.txt", blob]], 10, "A");
    const { nodes } = await derivePublicProjection(
      [a],
      new Map([[a.id, { state: "public" }]]),
    );
    const bundle = await buildPublicExportBundle(nodes, store);
    // Remove the object from the bundle.
    const tampered: PublicExportBundle = {
      manifest: bundle.manifest,
      objects: new Map(),
    };
    expect(await verifyPublicExportBundle(tampered)).toBe(false);
  });

  it("verifyPublicExportBundle rejects a bundle with corrupted object bytes", async () => {
    const store = new MemoryStore();
    const blob = await putBlob(store, "content");
    const a = await realSnap(store, null, [["a.txt", blob]], 10, "A");
    const { nodes } = await derivePublicProjection(
      [a],
      new Map([[a.id, { state: "public" }]]),
    );
    const bundle = await buildPublicExportBundle(nodes, store);
    const corrupted = new Map(bundle.objects);
    const orig = corrupted.get(blob)!;
    const bad = new Uint8Array(orig.bytes);
    bad[0] = bad[0] ^ 0xff;
    corrupted.set(blob, { kind: "blob", bytes: bad });
    const tampered: PublicExportBundle = { manifest: bundle.manifest, objects: corrupted };
    expect(await verifyPublicExportBundle(tampered)).toBe(false);
  });

  it("verifyPublicExportBundle rejects a tampered manifest hash", async () => {
    const store = new MemoryStore();
    const blob = await putBlob(store, "content");
    const a = await realSnap(store, null, [["a.txt", blob]], 10, "A");
    const { nodes } = await derivePublicProjection(
      [a],
      new Map([[a.id, { state: "public" }]]),
    );
    const bundle = await buildPublicExportBundle(nodes, store);
    const tampered: PublicExportBundle = {
      manifest: {
        ...bundle.manifest,
        publicManifestHash: asHash("b".repeat(64)),
      },
      objects: bundle.objects,
    };
    expect(await verifyPublicExportBundle(tampered)).toBe(false);
  });

  it("buildPublicExportBundle rejects a secret-blob referenced by a public entry (integrity, not privacy)", async () => {
    const store = new MemoryStore();
    // Create a secret-blob envelope and pretend a public entry references it.
    const secretObj = await createContentObject(
      "secret-blob",
      enc.encode("framed-ciphertext"),
    );
    store.putObject(secretObj);
    const entry: PublicEntry = { path: "leaked.txt", blobId: secretObj.id };
    // Build a node manually referencing the secret-blob id.
    const projId = asPublicProjectionId("1".repeat(64));
    const node = {
      projectionId: projId,
      publicEntries: [entry],
      parentProjectionIds: [],
    };
    await expect(buildPublicExportBundle([node], store)).rejects.toThrow();
  });
});

describe("C6 manifest-ref population via Snapshot.withManifestRefs + Store.putManifestRefs", () => {
  it("attachManifestRefs upserts the attachment without changing SnapshotId", async () => {
    const store = new MemoryStore();
    const blob = await putBlob(store, "x");
    const s = await realSnap(store, null, [["x.txt", blob]], 10, "S");
    const beforeEnvelope = store.getSnapshot(s.id);
    const pubHash = asHash("a".repeat(64));
    const privHash = asHash("b".repeat(64));
    const { snapshot: updated, refs } = attachManifestRefs(s, store, pubHash, privHash);
    // SnapshotId unchanged.
    expect(updated.id).toBe(s.id);
    // Refs upserted into the store attachment.
    expect(store.getManifestRefs(s.id)).toEqual({
      publicManifestRef: pubHash,
      privateManifestRef: privHash,
    });
    expect(refs.publicManifestRef).toBe(pubHash);
    expect(refs.privateManifestRef).toBe(privHash);
    expect(toSnapshotEnvelope(updated).serializedBytes).toEqual(
      beforeEnvelope.serializedBytes,
    );
    expect(store.getSnapshot(s.id).serializedBytes).toEqual(
      beforeEnvelope.serializedBytes,
    );
  });

  it("buildAndAttachManifests builds manifests and attaches refs (acyclic)", async () => {
    const store = new MemoryStore();
    const blob = await putBlob(store, "public");
    const s = await realSnap(store, null, [["pub.txt", blob]], 10, "S");
    const result = await buildAndAttachManifests(s, { state: "public" }, store);
    // SnapshotId unchanged.
    expect(result.updatedSnapshot.id).toBe(s.id);
    // publicManifestRef populated with the manifest self-hash.
    expect(store.getManifestRefs(s.id).publicManifestRef).toBe(
      result.publicManifestRef,
    );
    // privateManifestRef populated with the private manifest hash.
    expect(store.getManifestRefs(s.id).privateManifestRef).toBe(
      result.privateManifestRef,
    );
    // The manifest verifies.
    expect(await verifyPublicManifest(result.publicManifest)).toBe(true);
    // The projection id is a valid 64-char hex.
    expect(result.projectionId.length).toBe(64);
    const rebuilt = await buildAndAttachManifests(s, { state: "public" }, store);
    expect(rebuilt.publicManifestRef).toBe(result.publicManifestRef);
    expect(rebuilt.privateManifestRef).toBe(result.privateManifestRef);
  });

  it("changing only manifest refs does not change SnapshotId (decision 10)", async () => {
    const store = new MemoryStore();
    const blob = await putBlob(store, "x");
    const s = await realSnap(store, null, [["x.txt", blob]], 10, "S");
    const r1 = await buildAndAttachManifests(s, { state: "public" }, store);
    // Attach different refs (simulate a re-build with different parents).
    const attach2 = attachManifestRefs(
      s,
      store,
      asHash("c".repeat(64)),
      asHash("d".repeat(64)),
    );
    expect(attach2.snapshot.id).toBe(s.id);
    expect(r1.updatedSnapshot.id).toBe(s.id);
  });

  it("loadSnapshot round-trips the attached manifest refs", async () => {
    const store = new MemoryStore();
    const blob = await putBlob(store, "x");
    const s = await realSnap(store, null, [["x.txt", blob]], 10, "S");
    await buildAndAttachManifests(s, { state: "public" }, store);
    const loaded = await loadSnapshot(s.id, store);
    expect(loaded.id).toBe(s.id);
    expect(loaded.publicManifestRef).not.toBeNull();
    expect(loaded.privateManifestRef).not.toBeNull();
  });
});

describe("C6 acyclic manifest-ref mapping (decision 10)", () => {
  it("a snapshot's manifest can be computed and attached without a fixed-point cycle", async () => {
    const store = new MemoryStore();
    const blob = await putBlob(store, "x");
    const s = await realSnap(store, null, [["x.txt", blob]], 10, "S");
    // The SnapshotId is final before the manifest is computed. The manifest
    // hash depends on the projection id, which depends on public entries, NOT
    // on the manifest hash. Attaching the manifest hash does not change the id.
    const before = s.id;
    await buildAndAttachManifests(s, { state: "public" }, store);
    const after = store.getManifestRefs(s.id);
    expect(before).toBe(s.id);
    expect(after.publicManifestRef).not.toBeNull();
    expect(after.privateManifestRef).not.toBeNull();
  });
});


describe("C6 local-only export rejection (review finding 2)", () => {
  it("buildAndAttachManifests throws Denied for a local-only snapshot", async () => {
    const store = new MemoryStore();
    const blob = await putBlob(store, "x");
    const s = await realSnap(store, null, [["x.txt", blob]], 10, "S");
    await expect(
      buildAndAttachManifests(s, { state: "local-only" }, store),
    ).rejects.toBeInstanceOf(Denied);
    // No manifest refs were attached for a local-only snapshot.
    expect(store.getManifestRefs(s.id).publicManifestRef).toBeNull();
    expect(store.getManifestRefs(s.id).privateManifestRef).toBeNull();
  });

  it("buildAndAttachManifests does not build empty public refs for local-only", async () => {
    const store = new MemoryStore();
    const blob = await putBlob(store, "x");
    const s = await realSnap(store, null, [["x.txt", blob]], 10, "S");
    const err = await buildAndAttachManifests(s, { state: "local-only" }, store)
      .catch((e: unknown) => e as Denied);
    expect(err).toBeInstanceOf(Denied);
    expect(err.state).toBe("local-only");
    expect(err.op).toBe("export");
  });

  it("buildAndAttachManifests still succeeds for public/private/embargoed", async () => {
    const store = new MemoryStore();
    const blob = await putBlob(store, "pub");
    const s = await realSnap(store, null, [["pub.txt", blob]], 10, "S");
    const r = await buildAndAttachManifests(s, { state: "public" }, store);
    expect(r.publicManifestRef).not.toBeNull();
    // private/embargoed produce empty public entries but are not rejected:
    // they are exportable states (omitted from export, not denied).
    const s2 = await realSnap(store, null, [["pub.txt", blob]], 20, "S2");
    const r2 = await buildAndAttachManifests(s2, { state: "private" }, store);
    expect(r2.publicManifestRef).not.toBeNull();
    const s3 = await realSnap(store, null, [["pub.txt", blob]], 30, "S3");
    const r3 = await buildAndAttachManifests(s3, { state: "embargoed" }, store);
    expect(r3.publicManifestRef).not.toBeNull();
  });
});

describe("C6 bundle verification exactness (review finding 3)", () => {
  it("verifyPublicExportBundle rejects a bundle with an extra private bytes object", async () => {
    const store = new MemoryStore();
    const pubBlob = await putBlob(store, "public-content");
    const a = await realSnap(store, null, [["a.txt", pubBlob]], 10, "A");
    const { nodes } = await derivePublicProjection(
      [a],
      new Map([[a.id, { state: "public" }]]),
    );
    const bundle = await buildPublicExportBundle(nodes, store);

    // Smuggle an extra private bytes object into the bundle. Its id is valid
    // (a real content object) but is NOT referenced by manifest.publicEntries.
    const privBlob = await putBlob(store, "top-secret-private-bytes");
    const smuggled = new Map(bundle.objects);
    smuggled.set(privBlob, { kind: "blob", bytes: enc.encode("top-secret-private-bytes") });
    const tampered: PublicExportBundle = {
      manifest: bundle.manifest,
      objects: smuggled,
    };
    expect(await verifyPublicExportBundle(tampered)).toBe(false);
  });

  it("verifyPublicExportBundle rejects extra objects even when all referenced objects are valid", async () => {
    const store = new MemoryStore();
    const blob = await putBlob(store, "content");
    const a = await realSnap(store, null, [["a.txt", blob]], 10, "A");
    const { nodes } = await derivePublicProjection(
      [a],
      new Map([[a.id, { state: "public" }]]),
    );
    const bundle = await buildPublicExportBundle(nodes, store);
    // The referenced object is valid; add an unrelated valid blob object.
    const extra = await putBlob(store, "extra-unreferenced");
    const withExtra = new Map(bundle.objects);
    withExtra.set(extra, { kind: "blob", bytes: enc.encode("extra-unreferenced") });
    const tampered: PublicExportBundle = {
      manifest: bundle.manifest,
      objects: withExtra,
    };
    expect(await verifyPublicExportBundle(tampered)).toBe(false);
  });

  it("verifyPublicExportBundle accepts a bundle with exactly the referenced objects", async () => {
    const store = new MemoryStore();
    const blob = await putBlob(store, "content");
    const a = await realSnap(store, null, [["a.txt", blob]], 10, "A");
    const { nodes } = await derivePublicProjection(
      [a],
      new Map([[a.id, { state: "public" }]]),
    );
    const bundle = await buildPublicExportBundle(nodes, store);
    // Exactly one object, exactly the referenced one.
    expect(bundle.objects.size).toBe(1);
    expect(await verifyPublicExportBundle(bundle)).toBe(true);
  });
});

describe("C6 local-only export rejection across all export paths (review finding 1)", () => {
  it("derivePublicProjection throws Denied for a local-only snapshot in the chain", async () => {
    const store = new MemoryStore();
    const blob = await putBlob(store, "x");
    const a = await realSnap(store, null, [["x.txt", blob]], 10, "A");
    const l = await realSnap(store, a.id, [["x.txt", blob]], 20, "L local-only");
    const b = await realSnap(store, l.id, [["x.txt", blob]], 30, "B");
    const vis = new Map<SnapshotId, SnapshotVisibility>([
      [a.id, { state: "public" }],
      [l.id, { state: "local-only" }],
      [b.id, { state: "public" }],
    ]);
    await expect(derivePublicProjection([a, l, b], vis)).rejects.toBeInstanceOf(
      Denied,
    );
  });

  it("buildPublicExportBundle throws Denied when a node carries a local-only file", async () => {
    // A public snapshot with one local-only file: publicEntriesOf rejects it,
    // so the bundle path (derivePublicProjection -> buildPublicExportBundle)
    // cannot silently strip the local-only file out of the export.
    const store = new MemoryStore();
    const pubBlob = await putBlob(store, "pub");
    const locBlob = await putBlob(store, "local-secret");
    const s = await realSnap(
      store,
      null,
      [["pub.txt", pubBlob], ["local.txt", locBlob]],
      10,
      "mixed",
    );
    const vis: SnapshotVisibility = {
      state: "public",
      pathStates: new Map([["local.txt", "local-only"]]),
    };
    await expect(
      derivePublicProjection([s], new Map([[s.id, vis]])),
    ).rejects.toBeInstanceOf(Denied);
  });

  it("publicEntriesOf throws Denied for a local-only file within a public snapshot", async () => {
    const store = new MemoryStore();
    const pubBlob = await putBlob(store, "pub");
    const locBlob = await putBlob(store, "local-secret");
    const s = await realSnap(
      store,
      null,
      [["pub.txt", pubBlob], ["local.txt", locBlob]],
      10,
      "mixed",
    );
    const vis: SnapshotVisibility = {
      state: "public",
      pathStates: new Map([["local.txt", "local-only"]]),
    };
    // Synchronous throw: local-only file must not be silently omitted.
    expect(() => publicEntriesOf(s, vis)).toThrow(Denied);
    // A public snapshot with no local-only pathStates does not throw and
    // includes public paths (unmapped paths fall back to the public state).
    const pubOnly: SnapshotVisibility = { state: "public" };
    expect(publicEntriesOf(s, pubOnly).map((e) => e.path).sort()).toEqual(
      ["local.txt", "pub.txt"],
    );
  });

  it("local-only rejection carries the typed (state, op, role) triple", async () => {
    const store = new MemoryStore();
    const blob = await putBlob(store, "x");
    const s = await realSnap(store, null, [["x.txt", blob]], 10, "S");
    const vis = new Map<SnapshotId, SnapshotVisibility>([
      [s.id, { state: "local-only" }],
    ]);
    const err = await derivePublicProjection([s], vis).catch(
      (e: unknown) => e as Denied,
    );
    expect(err).toBeInstanceOf(Denied);
    expect(err.state).toBe("local-only");
    expect(err.op).toBe("export");
    expect(err.role).toBe("owner");
  });
});

describe("C6 local-only denial messages do not leak private metadata", () => {
  it("derivePublicProjection Denied message omits the private SnapshotId", async () => {
    const store = new MemoryStore();
    const blob = await putBlob(store, "x");
    const a = await realSnap(store, null, [["x.txt", blob]], 10, "A");
    const l = await realSnap(store, a.id, [["x.txt", blob]], 20, "L local-only");
    const vis = new Map<SnapshotId, SnapshotVisibility>([
      [l.id, { state: "local-only" }],
    ]);
    const err = await derivePublicProjection([l], vis).catch(
      (e: unknown) => e as Denied,
    );
    expect(err).toBeInstanceOf(Denied);
    expect(err.message).not.toContain(String(l.id));
    expect(err.message).not.toContain(l.id);
  });

  it("publicEntriesOf Denied message omits the private path", async () => {
    const store = new MemoryStore();
    const pubBlob = await putBlob(store, "pub");
    const locBlob = await putBlob(store, "local-secret");
    const s = await realSnap(
      store,
      null,
      [["pub.txt", pubBlob], ["local.txt", locBlob]],
      10,
      "mixed",
    );
    const vis: SnapshotVisibility = {
      state: "public",
      pathStates: new Map([["local.txt", "local-only"]]),
    };
    const err = (() => {
      try {
        publicEntriesOf(s, vis);
      } catch (e: unknown) {
        return e as Denied;
      }
      throw new Error("expected publicEntriesOf to throw");
    })();
    expect(err).toBeInstanceOf(Denied);
    expect(err.message).not.toContain("local.txt");
  });

  it("buildAndAttachManifests Denied message omits the private SnapshotId", async () => {
    const store = new MemoryStore();
    const blob = await putBlob(store, "x");
    const s = await realSnap(store, null, [["x.txt", blob]], 10, "S");
    const err = await buildAndAttachManifests(
      s,
      { state: "local-only" },
      store,
    ).catch((e: unknown) => e as Denied);
    expect(err).toBeInstanceOf(Denied);
    expect(err.message).not.toContain(String(s.id));
    expect(err.message).not.toContain(s.id);
  });
});

describe("C6 stale public entry dropping (review finding 2)", () => {
  it("buildPublicExportBundle drops a path removed by a later public snapshot", async () => {
    const store = new MemoryStore();
    const blobA = await putBlob(store, "a-content");
    const blobB = await putBlob(store, "b-content");
    // A: public with a.txt. B: public with b.txt only (a.txt removed).
    const a = await realSnap(store, null, [["a.txt", blobA]], 10, "A");
    const b = await realSnap(store, a.id, [["b.txt", blobB]], 20, "B");
    const vis = new Map<SnapshotId, SnapshotVisibility>([
      [a.id, { state: "public" }],
      [b.id, { state: "public" }],
    ]);
    const { nodes } = await derivePublicProjection([a, b], vis);
    const bundle = await buildPublicExportBundle(nodes, store);

    // The latest public state is B ({b.txt}); a.txt must not linger.
    const paths = bundle.manifest.publicEntries.map((e) => e.path);
    expect(paths).toEqual(["b.txt"]);
    expect(paths).not.toContain("a.txt");
    // The removed blob's object must not be carried in the bundle.
    expect(bundle.objects.has(blobA)).toBe(false);
    expect(bundle.objects.has(blobB)).toBe(true);
    // The removed path must not appear in the serialized manifest.
    const serializedStr = new TextDecoder().decode(
      serializePublicManifest(bundle.manifest),
    );
    expect(serializedStr).not.toContain("a.txt");
    expect(serializedStr).not.toContain(blobA);
  });

  it("buildPublicExportBundle drops a path that becomes private in a later public snapshot", async () => {
    const store = new MemoryStore();
    const pubBlob = await putBlob(store, "pub");
    const privBlob = await putBlob(store, "priv");
    // A: public with pub.txt and secret.txt (both public). B: public with
    // pub.txt public but secret.txt now private (file-level visibility).
    const a = await realSnap(
      store,
      null,
      [["pub.txt", pubBlob], ["secret.txt", privBlob]],
      10,
      "A",
    );
    const b = await realSnap(
      store,
      a.id,
      [["pub.txt", pubBlob], ["secret.txt", privBlob]],
      20,
      "B",
    );
    const vis = new Map<SnapshotId, SnapshotVisibility>([
      [a.id, { state: "public" }],
      [
        b.id,
        {
          state: "public",
          pathStates: new Map([["secret.txt", "private"]]),
        },
      ],
    ]);
    const { nodes } = await derivePublicProjection([a, b], vis);
    const bundle = await buildPublicExportBundle(nodes, store);

    // secret.txt became private in B: it must not linger in the final bundle.
    const paths = bundle.manifest.publicEntries.map((e) => e.path);
    expect(paths).toEqual(["pub.txt"]);
    expect(paths).not.toContain("secret.txt");
    expect(bundle.objects.has(privBlob)).toBe(false);
    expect(bundle.objects.has(pubBlob)).toBe(true);
  });

  it("buildPublicExportBundle reflects the latest state, not a union, when content changes", async () => {
    const store = new MemoryStore();
    const blob1 = await putBlob(store, "v1");
    const blob2 = await putBlob(store, "v2");
    // A: a.txt=v1. B: a.txt=v2 (same path, new content). Latest state is v2.
    const a = await realSnap(store, null, [["a.txt", blob1]], 10, "A");
    const b = await realSnap(store, a.id, [["a.txt", blob2]], 20, "B");
    const vis = new Map<SnapshotId, SnapshotVisibility>([
      [a.id, { state: "public" }],
      [b.id, { state: "public" }],
    ]);
    const { nodes } = await derivePublicProjection([a, b], vis);
    const bundle = await buildPublicExportBundle(nodes, store);
    expect(bundle.manifest.publicEntries.map((e) => e.path)).toEqual(["a.txt"]);
    expect(bundle.manifest.publicEntries[0].blobId).toBe(blob2);
    // The superseded blob must not be carried.
    expect(bundle.objects.has(blob1)).toBe(false);
    expect(bundle.objects.has(blob2)).toBe(true);
  });

  it("buildPublicExportBundle of an empty projection graph carries no entries or objects", async () => {
    const store = new MemoryStore();
    const bundle = await buildPublicExportBundle([], store);
    expect(bundle.manifest.publicEntries).toEqual([]);
    expect(bundle.objects.size).toBe(0);
    expect(await verifyPublicExportBundle(bundle)).toBe(true);
  });
});