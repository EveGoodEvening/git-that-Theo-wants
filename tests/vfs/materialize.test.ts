// C8 real-FS materialization adapter tests.
//
// Covers (plan C8 checklist):
//   - `materialize(publicProjection, targetDir)` writes the C6 public export
//     bundle's public blobs to real files at their public paths, byte-identical
//     to the original blob content.
//   - One-way: input is the C6-filtered public projection (`PublicExportBundle`),
//     never the raw `Snapshot`/`VirtualTree`.
//   - Export privacy invariant: the materialized temp dir contains ONLY public
//     entries — no private/local-only bytes, no private path strings, no private
//     blob/secret ids, no full `SnapshotId` values, no private metadata.
//   - `materialize` verifies the bundle first and refuses a smuggled bundle
//     (extra private object), a tampered manifest, or a missing/corrupt blob.
//   - Path-escape rejection: a public entry path that escapes `targetDir` is
//     refused.
//   - `FsStore` round-trips `ContentObject`/`SignedAclNode`/`SnapshotEnvelope`/
//     `ManifestRefs` and detects corrupt objects on read (truncation, bit-flip,
//     id mismatch).
//   - `FsStore` enforces append-only/idempotent conflict semantics matching
//     `MemoryStore`.

import { describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asHash,
  asSnapshotId,
  type Hash,
  type SnapshotId,
} from "../../src/core/ids.ts";
import {
  createContentObject,
  type ContentObject,
} from "../../src/core/object.ts";
import {
  createSignedAclNode,
  type SignedAclNode,
} from "../../src/core/acl.ts";
import {
  createSnapshot,
  saveSnapshot,
  toSnapshotEnvelope,
  type Snapshot,
} from "../../src/snapshot/snapshot.ts";
import { makeTree } from "../../src/vfs/vfs.ts";
import { MemoryStore } from "../../src/store/memory-store.ts";
import type { Store } from "../../src/store/store.ts";
import {
  AclConflict,
  NotFound,
  ObjectConflict,
  SnapshotConflict,
} from "../../src/store/store.ts";
import {
  FsStore,
  CorruptObject,
} from "../../src/store/fs-store.ts";
import {
  materialize,
  MaterializeError,
} from "../../src/vfs/materialize.ts";
import {
  buildPublicExportBundle,
  buildPublicManifest,
  derivePublicProjection,
  type PublicExportBundle,
  type SnapshotVisibility,
} from "../../src/export/public-manifest.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Create a fresh temp directory for a test. */
function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `gtw-c8-${prefix}-`));
}

/** Recursively list all relative file paths under `dir`. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  function walk(d: string, prefix: string): void {
    for (const name of readdirSync(d)) {
      const abs = join(d, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(abs).isDirectory()) {
        walk(abs, rel);
      } else {
        out.push(rel);
      }
    }
  }
  walk(dir, "");
  return out.sort();
}

/** Concatenate every byte of every file under `dir` as a single string. */
function allFileBytes(dir: string): string {
  return listFiles(dir)
    .map((f) => dec.decode(readFileSync(join(dir, f))))
    .join("");
}

/** Put a plain blob into the store and return its content `Hash`. */
async function putBlob(store: Store, content: string): Promise<Hash> {
  const obj = await createContentObject("blob", enc.encode(content));
  store.putObject(obj);
  return obj.id;
}

/** Build a real snapshot, save it, and return the `Snapshot`. */
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

// ===========================================================================
// materialize: byte-identical public files + privacy.
// ===========================================================================

describe("C8 materialize: byte-identical public files", () => {
  it("writes public blobs to real files at their public paths", async () => {
    const store = new MemoryStore();
    const pubBlob = await putBlob(store, "public-content");
    const a = await realSnap(store, null, [["pub.txt", pubBlob]], 10, "A");
    const vis = new Map<SnapshotId, SnapshotVisibility>([
      [a.id, { state: "public" }],
    ]);
    const { nodes } = await derivePublicProjection([a], vis);
    const bundle = await buildPublicExportBundle(nodes, store);

    const dir = freshDir("identical");
    const res = await materialize(bundle, dir);
    expect(res.writtenPaths).toEqual(["pub.txt"]);
    const onDisk = readFileSync(join(dir, "pub.txt"));
    expect(dec.decode(onDisk)).toBe("public-content");
    rmSync(dir, { recursive: true, force: true });
  });

  it("materializes nested directory paths", async () => {
    const store = new MemoryStore();
    const blob1 = await putBlob(store, "one");
    const blob2 = await putBlob(store, "two");
    const a = await realSnap(
      store,
      null,
      [["dir/nested/a.txt", blob1], ["dir/nested/b.txt", blob2]],
      10,
      "A",
    );
    const vis = new Map<SnapshotId, SnapshotVisibility>([
      [a.id, { state: "public" }],
    ]);
    const { nodes } = await derivePublicProjection([a], vis);
    const bundle = await buildPublicExportBundle(nodes, store);

    const dir = freshDir("nested");
    await materialize(bundle, dir);
    expect(dec.decode(readFileSync(join(dir, "dir/nested/a.txt")))).toBe("one");
    expect(dec.decode(readFileSync(join(dir, "dir/nested/b.txt")))).toBe("two");
    expect(listFiles(dir)).toEqual(["dir/nested/a.txt", "dir/nested/b.txt"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("byte-identical for binary content", async () => {
    const store = new MemoryStore();
    const binary = new Uint8Array([0, 1, 2, 255, 254, 0, 128, 64]);
    const obj = await createContentObject("blob", binary);
    store.putObject(obj);
    const a = await realSnap(store, null, [["bin.dat", obj.id]], 10, "A");
    const vis = new Map<SnapshotId, SnapshotVisibility>([
      [a.id, { state: "public" }],
    ]);
    const { nodes } = await derivePublicProjection([a], vis);
    const bundle = await buildPublicExportBundle(nodes, store);

    const dir = freshDir("binary");
    await materialize(bundle, dir);
    const onDisk = new Uint8Array(readFileSync(join(dir, "bin.dat")).buffer);
    expect(onDisk.length).toBe(binary.length);
    for (let i = 0; i < binary.length; i++) {
      expect(onDisk[i]).toBe(binary[i]);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("clears the target dir by default (no stale files linger)", async () => {
    const store = new MemoryStore();
    const blobA = await putBlob(store, "a");
    const a = await realSnap(store, null, [["a.txt", blobA]], 10, "A");
    const vis = new Map<SnapshotId, SnapshotVisibility>([
      [a.id, { state: "public" }],
    ]);
    const { nodes } = await derivePublicProjection([a], vis);
    const bundle = await buildPublicExportBundle(nodes, store);

    const dir = freshDir("clear");
    // Pre-create a stale file that should be removed on materialize.
    writeFileSync(join(dir, "stale.txt"), "stale");
    expect(existsSync(join(dir, "stale.txt"))).toBe(true);

    await materialize(bundle, dir);
    expect(existsSync(join(dir, "stale.txt"))).toBe(false);
    expect(listFiles(dir)).toEqual(["a.txt"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("materializes an empty projection to an empty dir", async () => {
    const store = new MemoryStore();
    const bundle = await buildPublicExportBundle([], store);
    const dir = freshDir("empty");
    const res = await materialize(bundle, dir);
    expect(res.writtenPaths).toEqual([]);
    expect(listFiles(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ===========================================================================
// materialize: export privacy invariant.
// ===========================================================================

describe("C8 materialize: export privacy invariant", () => {
  it("materialized dir contains no private bytes, private paths, blob/secret ids, SnapshotIds, or private metadata", async () => {
    const store = new MemoryStore();
    const pubBlob = await putBlob(store, "public-content");
    const privBlob = await putBlob(store, "top-secret-private-bytes");

    // A: public snapshot with one public file.
    const a = await realSnap(store, null, [["pub.txt", pubBlob]], 10, "A public");
    // P: private-only snapshot with a private file (private path + private bytes).
    const p = await realSnap(
      store,
      a.id,
      [["pub.txt", pubBlob], ["secret.txt", privBlob]],
      20,
      "P private message",
    );
    // B: public snapshot, same public entries as A (descended from P).
    const b = await realSnap(store, p.id, [["pub.txt", pubBlob]], 30, "B public");

    const vis = new Map<SnapshotId, SnapshotVisibility>([
      [a.id, { state: "public" }],
      [p.id, { state: "private" }],
      [b.id, { state: "public" }],
    ]);
    const { nodes } = await derivePublicProjection([a, p, b], vis);
    const bundle = await buildPublicExportBundle(nodes, store);

    const dir = freshDir("privacy");
    await materialize(bundle, dir);

    const files = listFiles(dir);
    const allBytes = allFileBytes(dir);

    // Only the public path appears on disk.
    expect(files).toEqual(["pub.txt"]);
    // No private path string.
    expect(allBytes.includes("secret.txt")).toBe(false);
    // No private bytes.
    expect(allBytes.includes("top-secret-private-bytes")).toBe(false);
    // No private message.
    expect(allBytes.includes("P private message")).toBe(false);
    // No full SnapshotId values (the public blob id is content-addressed and
    // public by design; the invariant is that no *snapshot* ids appear).
    expect(allBytes.includes(a.id)).toBe(false);
    expect(allBytes.includes(p.id)).toBe(false);
    expect(allBytes.includes(b.id)).toBe(false);
    // No private manifest refs / private metadata: the only file is pub.txt
    // with exactly "public-content".
    expect(allBytes).toBe("public-content");

    rmSync(dir, { recursive: true, force: true });
  });

  it("drops a path that becomes private in a later public snapshot (no lingering private path)", async () => {
    const store = new MemoryStore();
    const pubBlob = await putBlob(store, "pub");
    const privBlob = await putBlob(store, "priv-bytes");

    // A: public with pub.txt and secret.txt both public.
    const a = await realSnap(
      store,
      null,
      [["pub.txt", pubBlob], ["secret.txt", pubBlob]],
      10,
      "A",
    );
    // B: public, secret.txt becomes private (removed from public entries).
    const b = await realSnap(
      store,
      a.id,
      [["pub.txt", pubBlob], ["secret.txt", privBlob]],
      20,
      "B",
    );
    const vis = new Map<SnapshotId, SnapshotVisibility>([
      [a.id, { state: "public" }],
      [b.id, { state: "public", pathStates: new Map([["secret.txt", "private"]]) }],
    ]);
    const { nodes } = await derivePublicProjection([a, b], vis);
    const bundle = await buildPublicExportBundle(nodes, store);

    const dir = freshDir("privacy-drop");
    await materialize(bundle, dir);
    const files = listFiles(dir);
    expect(files).toEqual(["pub.txt"]);
    expect(allFileBytes(dir)).toBe("pub");
    rmSync(dir, { recursive: true, force: true });
  });
});

// ===========================================================================
// materialize: bundle integrity enforcement (refuses smuggled/tampered input).
// ===========================================================================

describe("C8 materialize: refuses unsafe / smuggled input", () => {
  it("refuses a bundle that smuggles an extra private object", async () => {
    const store = new MemoryStore();
    const pubBlob = await putBlob(store, "public");
    const privBlob = await putBlob(store, "top-secret-private-bytes");
    const a = await realSnap(store, null, [["pub.txt", pubBlob]], 10, "A");
    const vis = new Map<SnapshotId, SnapshotVisibility>([
      [a.id, { state: "public" }],
    ]);
    const { nodes } = await derivePublicProjection([a], vis);
    const bundle = await buildPublicExportBundle(nodes, store);

    // Smuggle an extra private object into the bundle.
    const smuggled = new Map(bundle.objects);
    smuggled.set(privBlob, { kind: "blob", bytes: enc.encode("top-secret-private-bytes") });
    const tampered: PublicExportBundle = {
      manifest: bundle.manifest,
      objects: smuggled,
    };

    const dir = freshDir("smuggle");
    await expect(materialize(tampered, dir)).rejects.toBeInstanceOf(MaterializeError);
    // Nothing should have been written (clear happens after verification, but
    // verification fails first so the original dir is untouched; the stale
    // check below confirms no materialized files).
    expect(listFiles(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a bundle with a tampered manifest hash", async () => {
    const store = new MemoryStore();
    const pubBlob = await putBlob(store, "public");
    const a = await realSnap(store, null, [["pub.txt", pubBlob]], 10, "A");
    const vis = new Map<SnapshotId, SnapshotVisibility>([
      [a.id, { state: "public" }],
    ]);
    const { nodes } = await derivePublicProjection([a], vis);
    const bundle = await buildPublicExportBundle(nodes, store);

    const tampered: PublicExportBundle = {
      manifest: { ...bundle.manifest, publicManifestHash: asHash("b".repeat(64)) },
      objects: bundle.objects,
    };
    const dir = freshDir("tampered");
    await expect(materialize(tampered, dir)).rejects.toBeInstanceOf(MaterializeError);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a bundle missing a referenced object", async () => {
    const store = new MemoryStore();
    const pubBlob = await putBlob(store, "public");
    const a = await realSnap(store, null, [["pub.txt", pubBlob]], 10, "A");
    const vis = new Map<SnapshotId, SnapshotVisibility>([
      [a.id, { state: "public" }],
    ]);
    const { nodes } = await derivePublicProjection([a], vis);
    const bundle = await buildPublicExportBundle(nodes, store);

    const tampered: PublicExportBundle = {
      manifest: bundle.manifest,
      objects: new Map(),
    };
    const dir = freshDir("missing");
    await expect(materialize(tampered, dir)).rejects.toBeInstanceOf(MaterializeError);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a public entry path that escapes the target dir", async () => {
    const store = new MemoryStore();
    const pubBlob = await putBlob(store, "public");
    // Build a valid manifest with an escaping path.
    const manifest = await buildPublicManifest([], [
      { path: "../escape.txt", blobId: pubBlob },
    ]);
    const objects = new Map<Hash, { readonly kind: "blob"; readonly bytes: Uint8Array }>();
    objects.set(pubBlob, { kind: "blob", bytes: enc.encode("public") });
    const bundle: PublicExportBundle = { manifest, objects };

    const dir = freshDir("escape");
    await expect(materialize(bundle, dir)).rejects.toBeInstanceOf(MaterializeError);
    // The escape file must not have been written outside the dir.
    expect(existsSync(join(dir, "..", "escape.txt"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses an absolute public entry path", async () => {
    const store = new MemoryStore();
    const pubBlob = await putBlob(store, "public");
    const manifest = await buildPublicManifest([], [
      { path: "/etc/evil.txt", blobId: pubBlob },
    ]);
    const objects = new Map<Hash, { readonly kind: "blob"; readonly bytes: Uint8Array }>();
    objects.set(pubBlob, { kind: "blob", bytes: enc.encode("public") });
    const bundle: PublicExportBundle = { manifest, objects };

    const dir = freshDir("abs");
    await expect(materialize(bundle, dir)).rejects.toBeInstanceOf(MaterializeError);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ===========================================================================
// FsStore: round-trip + corrupt-object detection.
// ===========================================================================

describe("C8 FsStore: round-trip and conflict semantics", () => {
  it("round-trips a ContentObject (blob)", async () => {
    const dir = freshDir("fs-obj");
    const store = new FsStore(dir);
    const obj = await createContentObject("blob", enc.encode("hello"));
    store.putObject(obj);
    expect(store.hasObject(obj.id)).toBe(true);
    const got = store.getObject(obj.id);
    expect(got.id).toBe(obj.id);
    expect(got.kind).toBe("blob");
    expect(dec.decode(got.bytes)).toBe("hello");
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a ContentObject (secret-blob kind)", async () => {
    const dir = freshDir("fs-secret");
    const store = new FsStore(dir);
    const obj = await createContentObject("secret-blob", enc.encode("ciphertext"));
    store.putObject(obj);
    const got = store.getObject(obj.id);
    expect(got.kind).toBe("secret-blob");
    expect(dec.decode(got.bytes)).toBe("ciphertext");
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a SignedAclNode", async () => {
    const dir = freshDir("fs-acl");
    const store = new FsStore(dir);
    const key = enc.encode("local-test-key-123456");
    const node = await createSignedAclNode(
      {
        subject: "alice" as never,
        object: asHash("a".repeat(64)),
        permissions: new Set(["read", "publish"] as never),
      },
      key,
    );
    store.putAcl(node);
    const got = store.getAcl(node.id);
    expect(got.id).toBe(node.id);
    expect(got.record.subject).toBe("alice");
    expect([...got.record.permissions].sort()).toEqual(["publish", "read"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a SnapshotEnvelope and lists snapshots", async () => {
    const dir = freshDir("fs-snap");
    const store = new FsStore(dir);
    const tree = makeTree(null, new Map([["a.txt", asHash("a".repeat(64))]]));
    const snap = await createSnapshot(null, tree, 10, "msg", false);
    const env = toSnapshotEnvelope(snap);
    store.putSnapshot(env);
    const got = store.getSnapshot(snap.id);
    expect(got.id).toBe(snap.id);
    expect(got.parentId).toBe(null);
    expect(store.listSnapshots()).toEqual([snap.id]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips ManifestRefs (default + upsert + idempotent)", () => {
    const dir = freshDir("fs-refs");
    const store = new FsStore(dir);
    const sid = asSnapshotId("1".repeat(64));
    // Default when absent.
    expect(store.getManifestRefs(sid)).toEqual({
      publicManifestRef: null,
      privateManifestRef: null,
    });
    const refs = {
      publicManifestRef: asHash("a".repeat(64)),
      privateManifestRef: asHash("b".repeat(64)),
    };
    store.putManifestRefs(sid, refs);
    expect(store.getManifestRefs(sid)).toEqual(refs);
    // Idempotent re-put.
    store.putManifestRefs(sid, refs);
    expect(store.getManifestRefs(sid)).toEqual(refs);
    // Upsert changes.
    const refs2 = { publicManifestRef: null, privateManifestRef: null };
    store.putManifestRefs(sid, refs2);
    expect(store.getManifestRefs(sid)).toEqual(refs2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("putObject is idempotent for an identical object and conflicts on different bytes", async () => {
    const dir = freshDir("fs-obj-conflict");
    const store = new FsStore(dir);
    const obj = await createContentObject("blob", enc.encode("same"));
    store.putObject(obj);
    // Idempotent.
    store.putObject(obj);
    // Conflict: same id, different bytes.
    const conflicting: ContentObject = {
      id: obj.id,
      kind: "blob",
      bytes: enc.encode("different"),
    };
    expect(() => store.putObject(conflicting)).toThrow(ObjectConflict);
    rmSync(dir, { recursive: true, force: true });
  });

  it("putAcl conflicts on different immutable data", async () => {
    const dir = freshDir("fs-acl-conflict");
    const store = new FsStore(dir);
    const key = enc.encode("local-test-key-123456");
    const node = await createSignedAclNode(
      {
        subject: "alice" as never,
        object: asHash("a".repeat(64)),
        permissions: new Set(["read"] as never),
      },
      key,
    );
    store.putAcl(node);
    // Idempotent.
    store.putAcl(node);
    // Conflict: same id (forced) with different record. We cannot easily forge
    // a same-id/different-data node without re-hashing, so construct one with
    // the same id but mutated record fields.
    const tampered: SignedAclNode = {
      id: node.id,
      record: { ...node.record, subject: "bob" as never },
      signature: node.signature,
    };
    expect(() => store.putAcl(tampered)).toThrow(AclConflict);
    rmSync(dir, { recursive: true, force: true });
  });

  it("putSnapshot conflicts on different core bytes", async () => {
    const dir = freshDir("fs-snap-conflict");
    const store = new FsStore(dir);
    const tree = makeTree(null, new Map([["a.txt", asHash("a".repeat(64))]]));
    const snap = await createSnapshot(null, tree, 10, "msg", false);
    const env = toSnapshotEnvelope(snap);
    store.putSnapshot(env);
    // Idempotent.
    store.putSnapshot(env);
    // Conflict: same id, different serializedBytes.
    const tampered = {
      id: env.id,
      parentId: env.parentId,
      serializedBytes: new Uint8Array([9, 9, 9]),
    };
    expect(() => store.putSnapshot(tampered)).toThrow(SnapshotConflict);
    rmSync(dir, { recursive: true, force: true });
  });

  it("getObject/getAcl/getSnapshot throw NotFound when absent", async () => {
    const dir = freshDir("fs-notfound");
    const store = new FsStore(dir);
    expect(() => store.getObject(asHash("a".repeat(64)))).toThrow(NotFound);
    expect(() => store.getAcl(asHash("a".repeat(64)) as never)).toThrow(NotFound);
    expect(() => store.getSnapshot(asSnapshotId("a".repeat(64)))).toThrow(NotFound);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("C8 FsStore: corrupt-object detection", () => {
  it("detects a bit-flip in a ContentObject body (hash mismatch)", async () => {
    const dir = freshDir("fs-corrupt-obj");
    const store = new FsStore(dir);
    const obj = await createContentObject("blob", enc.encode("hello world"));
    store.putObject(obj);

    // Flip a body byte. Body starts after: "content"(7)+NUL(1)+magic(1)+version(1)+kindTag(1)+len("11")(2)+NUL(1)=14.
    const path = join(dir, "objects", obj.id);
    const bytes = new Uint8Array(readFileSync(path));
    bytes[14] = bytes[14] === 0x68 ? 0x69 : 0x68; // 'h' <-> 'i'
    writeFileSync(path, bytes);

    expect(() => store.getObject(obj.id)).toThrow(CorruptObject);
    rmSync(dir, { recursive: true, force: true });
  });

  it("detects a truncated ContentObject file", async () => {
    const dir = freshDir("fs-trunc-obj");
    const store = new FsStore(dir);
    const obj = await createContentObject("blob", enc.encode("hello world"));
    store.putObject(obj);

    const path = join(dir, "objects", obj.id);
    const bytes = readFileSync(path);
    // Truncate to just a few bytes.
    writeFileSync(path, bytes.subarray(0, 5));

    expect(() => store.getObject(obj.id)).toThrow(CorruptObject);
    rmSync(dir, { recursive: true, force: true });
  });

  it("detects a bit-flip in a SignedAclNode (id mismatch)", async () => {
    const dir = freshDir("fs-corrupt-acl");
    const store = new FsStore(dir);
    const key = enc.encode("local-test-key-123456");
    const node = await createSignedAclNode(
      {
        subject: "alice" as never,
        object: asHash("a".repeat(64)),
        permissions: new Set(["read"] as never),
      },
      key,
    );
    store.putAcl(node);

    // Flip a byte in the canonical record region (early in the file).
    const path = join(dir, "acls", node.id);
    const bytes = new Uint8Array(readFileSync(path));
    bytes[2] = bytes[2] === 0 ? 1 : 0;
    writeFileSync(path, bytes);

    expect(() => store.getAcl(node.id)).toThrow(CorruptObject);
    rmSync(dir, { recursive: true, force: true });
  });

  it("detects a bit-flip in a SnapshotEnvelope (parse failure / id mismatch)", async () => {
    const dir = freshDir("fs-corrupt-snap");
    const store = new FsStore(dir);
    const tree = makeTree(null, new Map([["a.txt", asHash("a".repeat(64))]]));
    const snap = await createSnapshot(null, tree, 10, "msg", false);
    const env = toSnapshotEnvelope(snap);
    store.putSnapshot(env);

    const path = join(dir, "snapshots", snap.id);
    const bytes = new Uint8Array(readFileSync(path));
    // Flip a byte in the serialized core bytes region (early).
    bytes[2] = bytes[2] === 0 ? 1 : 0;
    writeFileSync(path, bytes);

    expect(() => store.getSnapshot(snap.id)).toThrow(CorruptObject);
    rmSync(dir, { recursive: true, force: true });
  });

  it("detects a corrupt ManifestRefs JSON file", async () => {
    const dir = freshDir("fs-corrupt-refs");
    const store = new FsStore(dir);
    const sid = asSnapshotId("1".repeat(64));
    store.putManifestRefs(sid, {
      publicManifestRef: asHash("a".repeat(64)),
      privateManifestRef: null,
    });
    const path = join(dir, "manifest-refs", `${sid}.json`);
    writeFileSync(path, "{not valid json");
    expect(() => store.getManifestRefs(sid)).toThrow(CorruptObject);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ===========================================================================
// FsStore: compatibility with the C6 public export bundle path.
// ===========================================================================

describe("C8 FsStore: compatibility with C6 public export bundle", () => {
  it("FsStore-backed projection materializes identically to MemoryStore", async () => {
    // Use FsStore as the Store for building a public export bundle, then
    // materialize. This exercises FsStore's compatibility with the C2 Store
    // contract as used by C6.
    const dir = freshDir("fs-compat");
    const store = new FsStore(join(dir, "store"));
    const pubBlob = await putBlob(store, "fs-public-content");
    const a = await realSnap(store, null, [["pub.txt", pubBlob]], 10, "A");
    const vis = new Map<SnapshotId, SnapshotVisibility>([
      [a.id, { state: "public" }],
    ]);
    const { nodes } = await derivePublicProjection([a], vis);
    const bundle = await buildPublicExportBundle(nodes, store);

    const outDir = join(dir, "out");
    const res = await materialize(bundle, outDir);
    expect(res.writtenPaths).toEqual(["pub.txt"]);
    expect(dec.decode(readFileSync(join(outDir, "pub.txt")))).toBe("fs-public-content");
    rmSync(dir, { recursive: true, force: true });
  });
});

// ===========================================================================
// materialize: path safety (dot segments, platform separators, aliases).
// ===========================================================================

describe("C8 materialize: path safety rejects dot segments and platform aliases", () => {
  /** Build a single-entry bundle with a custom path (no path validation at build). */
  async function singleEntryBundle(
    path: string,
    content: string,
  ): Promise<PublicExportBundle> {
    const store = new MemoryStore();
    const blob = await putBlob(store, content);
    const manifest = await buildPublicManifest([], [{ path, blobId: blob }]);
    const objects = new Map<Hash, { readonly kind: "blob"; readonly bytes: Uint8Array }>();
    objects.set(blob, { kind: "blob", bytes: enc.encode(content) });
    return { manifest, objects };
  }

  it("rejects a `..` component (a/../b.txt) without writing", async () => {
    const bundle = await singleEntryBundle("a/../b.txt", "x");
    const dir = freshDir("dotdot");
    await expect(materialize(bundle, dir)).rejects.toBeInstanceOf(MaterializeError);
    expect(listFiles(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a `.` component (./x) without writing", async () => {
    const bundle = await singleEntryBundle("./x", "x");
    const dir = freshDir("dot");
    await expect(materialize(bundle, dir)).rejects.toBeInstanceOf(MaterializeError);
    expect(listFiles(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a trailing `.` component (a/.) without writing", async () => {
    const bundle = await singleEntryBundle("a/.", "x");
    const dir = freshDir("dottrail");
    await expect(materialize(bundle, dir)).rejects.toBeInstanceOf(MaterializeError);
    expect(listFiles(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a backslash separator (Windows alias) without writing", async () => {
    const bundle = await singleEntryBundle("a\\b.txt", "x");
    const dir = freshDir("backslash");
    await expect(materialize(bundle, dir)).rejects.toBeInstanceOf(MaterializeError);
    expect(listFiles(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a leading slash (empty first component) without writing", async () => {
    const bundle = await singleEntryBundle("/x", "x");
    const dir = freshDir("leadslash");
    await expect(materialize(bundle, dir)).rejects.toBeInstanceOf(MaterializeError);
    expect(listFiles(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a double slash (empty middle component) without writing", async () => {
    const bundle = await singleEntryBundle("a//b.txt", "x");
    const dir = freshDir("dbls slash");
    await expect(materialize(bundle, dir)).rejects.toBeInstanceOf(MaterializeError);
    expect(listFiles(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a trailing slash (empty last component) without writing", async () => {
    const bundle = await singleEntryBundle("a/", "x");
    const dir = freshDir("trailslash");
    await expect(materialize(bundle, dir)).rejects.toBeInstanceOf(MaterializeError);
    expect(listFiles(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects duplicate normalized aliases (two entries resolving to the same absolute path) without writing", async () => {
    // Two manifest entries that resolve to the same absolute path would
    // silently overwrite one file with another's bytes. The pre-write
    // validation detects the collision up front and refuses the whole export.
    // Use two identical path strings (the manifest does not dedupe entries).
    const store = new MemoryStore();
    const blob = await putBlob(store, "x");
    const manifest = await buildPublicManifest([], [
      { path: "a.txt", blobId: blob },
      { path: "a.txt", blobId: blob },
    ]);
    const objects = new Map<Hash, { readonly kind: "blob"; readonly bytes: Uint8Array }>();
    objects.set(blob, { kind: "blob", bytes: enc.encode("x") });
    const bundle: PublicExportBundle = { manifest, objects };
    const dir = freshDir("dupalias");
    await expect(materialize(bundle, dir)).rejects.toBeInstanceOf(MaterializeError);
    expect(listFiles(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
  it("rejects a NUL byte in the path without writing", async () => {
    // A NUL byte is invalid in filenames on every common platform and must be
    // refused during prevalidation, before any filesystem mutation.
    const bundle = await singleEntryBundle("a\0b.txt", "x");
    const dir = freshDir("nul");
    await expect(materialize(bundle, dir)).rejects.toBeInstanceOf(MaterializeError);
    expect(listFiles(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ===========================================================================
// materialize: invalid manifest leaves existing target untouched.
// ===========================================================================

describe("C8 materialize: invalid manifest leaves existing target untouched", () => {
  it("an unsafe path in a later entry leaves pre-existing target files intact", async () => {
    // Pre-populate the target with an existing file. The bundle has two
    // entries: a valid one and an unsafe one (dot segment). Because validation
    // runs over ALL entries before any clear/write, the existing file must
    // remain and no partial export must occur.
    const store = new MemoryStore();
    const blob = await putBlob(store, "good");
    const manifest = await buildPublicManifest([], [
      { path: "good.txt", blobId: blob },
      { path: "../escape.txt", blobId: blob },
    ]);
    const objects = new Map<Hash, { readonly kind: "blob"; readonly bytes: Uint8Array }>();
    objects.set(blob, { kind: "blob", bytes: enc.encode("good") });
    const bundle: PublicExportBundle = { manifest, objects };

    const dir = freshDir("preserve");
    writeFileSync(join(dir, "preexisting.txt"), "keep-me");
    await expect(materialize(bundle, dir)).rejects.toBeInstanceOf(MaterializeError);
    // The pre-existing file is untouched (no clear happened).
    expect(existsSync(join(dir, "preexisting.txt"))).toBe(true);
    expect(dec.decode(readFileSync(join(dir, "preexisting.txt")))).toBe("keep-me");
    // No partial export of the valid entry.
    expect(existsSync(join(dir, "good.txt"))).toBe(false);
    expect(listFiles(dir)).toEqual(["preexisting.txt"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a missing referenced object in a later entry leaves pre-existing target intact", async () => {
    // The bundle verification already rejects a missing object, but the
    // pre-write validation must also catch it before clear so the target is
    // never partially exported even if verification is bypassed in a future
    // refactor. Construct a bundle whose manifest references a blob not in the
    // objects map.
    const store = new MemoryStore();
    const blob = await putBlob(store, "good");
    const missingBlob = asHash("f".repeat(64));
    const manifest = await buildPublicManifest([], [
      { path: "good.txt", blobId: blob },
      { path: "other.txt", blobId: missingBlob },
    ]);
    const objects = new Map<Hash, { readonly kind: "blob"; readonly bytes: Uint8Array }>();
    objects.set(blob, { kind: "blob", bytes: enc.encode("good") });
    const bundle: PublicExportBundle = { manifest, objects };

    const dir = freshDir("preserve-missing");
    writeFileSync(join(dir, "preexisting.txt"), "keep-me");
    await expect(materialize(bundle, dir)).rejects.toBeInstanceOf(MaterializeError);
    expect(existsSync(join(dir, "preexisting.txt"))).toBe(true);
    expect(listFiles(dir)).toEqual(["preexisting.txt"]);
    rmSync(dir, { recursive: true, force: true });
  });
  it("a NUL byte in a later-sorted path leaves pre-existing target files intact (no partial export)", async () => {
    // Regression: a hash-valid bundle carrying a NUL byte inside a public
    // entry path. `verifyPublicExportBundle` does not inspect path bytes (the
    // manifest framing is length-prefixed, so a NUL serializes and hashes
    // fine), so the bundle passes integrity verification. The prevalidation in
    // `safeResolvePath` must reject the NUL-bearing path BEFORE any target
    // clearing or writes happen: the pre-existing file stays, the valid
    // earlier entry is not partially exported, and the error is a typed
    // `MaterializeError` (not a raw OS error thrown after `rmSync`).
    //
    // `z\0.txt` sorts after `good.txt`, so the NUL path is the later entry;
    // this confirms validation covers every entry, not just the first.
    const store = new MemoryStore();
    const blob = await putBlob(store, "good");
    const manifest = await buildPublicManifest([], [
      { path: "good.txt", blobId: blob },
      { path: "z\0.txt", blobId: blob },
    ]);
    const objects = new Map<Hash, { readonly kind: "blob"; readonly bytes: Uint8Array }>();
    objects.set(blob, { kind: "blob", bytes: enc.encode("good") });
    const bundle: PublicExportBundle = { manifest, objects };

    const dir = freshDir("preserve-nul");
    writeFileSync(join(dir, "preexisting.txt"), "keep-me");
    await expect(materialize(bundle, dir)).rejects.toBeInstanceOf(MaterializeError);
    // The pre-existing file is untouched (no clear happened).
    expect(existsSync(join(dir, "preexisting.txt"))).toBe(true);
    expect(dec.decode(readFileSync(join(dir, "preexisting.txt")))).toBe("keep-me");
    // No partial export of the valid earlier entry.
    expect(existsSync(join(dir, "good.txt"))).toBe(false);
    expect(listFiles(dir)).toEqual(["preexisting.txt"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("path-prefix file/directory conflict leaves existing target untouched", async () => {
    // Regression: `a` and `a/b` cannot both be materialized because `a` would
    // need to be a file and a directory. The conflict must be rejected during
    // preflight, before the target is cleared or any partial export is written.
    const store = new MemoryStore();
    const parentBlob = await putBlob(store, "parent-file");
    const childBlob = await putBlob(store, "child-file");
    const manifest = await buildPublicManifest([], [
      { path: "a", blobId: parentBlob },
      { path: "a/b", blobId: childBlob },
    ]);
    const objects = new Map<Hash, { readonly kind: "blob"; readonly bytes: Uint8Array }>();
    objects.set(parentBlob, { kind: "blob", bytes: enc.encode("parent-file") });
    objects.set(childBlob, { kind: "blob", bytes: enc.encode("child-file") });
    const bundle: PublicExportBundle = { manifest, objects };

    const dir = freshDir("preserve-prefix-conflict");
    writeFileSync(join(dir, "preexisting.txt"), "keep-me");
    await expect(materialize(bundle, dir)).rejects.toBeInstanceOf(MaterializeError);
    expect(existsSync(join(dir, "preexisting.txt"))).toBe(true);
    expect(dec.decode(readFileSync(join(dir, "preexisting.txt")))).toBe("keep-me");
    expect(existsSync(join(dir, "a"))).toBe(false);
    expect(listFiles(dir)).toEqual(["preexisting.txt"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ===========================================================================
// FsStore: SnapshotId recompute from core bytes + parent/core consistency.
// ===========================================================================

describe("C8 FsStore: SnapshotId recompute and parent/core consistency", () => {
  it("getSnapshot recomputes SnapshotId from core serializedBytes and rejects a same-length core bit-flip", async () => {
    const dir = freshDir("fs-snap-coreflip");
    const store = new FsStore(dir);
    const tree = makeTree(null, new Map([["a.txt", asHash("a".repeat(64))]]));
    const snap = await createSnapshot(null, tree, 10, "msg", false);
    const env = toSnapshotEnvelope(snap);
    store.putSnapshot(env);

    const path = join(dir, "snapshots", snap.id);
    const bytes = new Uint8Array(readFileSync(path));
    // Find the core serializedBytes region inside the envelope file and flip
    // one byte without changing the file length. The envelope framing is:
    //   snap\0<magic(1)><ver(1)><flag(1)><parentId-hex(0|64)><len>\0<core bytes><id-hex(64)>\0
    // The core bytes are the payload after the length NUL. Flip a core byte:
    // the recomputed core id will differ from the filename, even though the
    // outer envelope id-hex (and file length) is unchanged.
    // Header: "snap"(4)+NUL(1)+magic(1)+ver(1)+flag(1) = 8 bytes; flag=0x00
    // (no parent), then len-decimal + NUL, then core bytes.
    // Length of "snap\0\x03\x01\x00" = 8; core length is env.serializedBytes.length.
    // The decimal length of the core is encoded before the NUL. Find the NUL
    // after the length field, then flip the first core byte.
    let nulAfterLen = -1;
    for (let i = 8; i < bytes.length; i++) {
      if (bytes[i] === 0) { nulAfterLen = i; break; }
    }
    expect(nulAfterLen).toBeGreaterThan(8);
    const coreStart = nulAfterLen + 1;
    bytes[coreStart] = bytes[coreStart] === 0 ? 1 : 0;
    writeFileSync(path, bytes);

    expect(() => store.getSnapshot(snap.id)).toThrow(CorruptObject);
    rmSync(dir, { recursive: true, force: true });
  });

  it("getSnapshot rejects a parent/core mismatch (header parentId swapped, core bytes unchanged)", async () => {
    const dir = freshDir("fs-snap-parentmismatch");
    const store = new FsStore(dir);
    // Root snapshot (parentId null) so the core has flag 0x00 and no parent
    // bytes. We cannot easily rewrite the header parentId without also
    // changing the framing length, so instead construct a child snapshot and
    // corrupt the header parent hex while leaving the core (and thus the id)
    // intact — the recomputed core id still matches, but the header parentId
    // no longer matches the core parentId.
    const tree = makeTree(null, new Map([["a.txt", asHash("a".repeat(64))]]));
    const parent = await createSnapshot(null, tree, 5, "parent", false);
    const parentEnv = toSnapshotEnvelope(parent);
    store.putSnapshot(parentEnv);

    const childTree = makeTree(parent.id, new Map([["b.txt", asHash("b".repeat(64))]]));
    const child = await createSnapshot(parent.id, childTree, 10, "child", false);
    const childEnv = toSnapshotEnvelope(child);
    store.putSnapshot(childEnv);

    const path = join(dir, "snapshots", child.id);
    const bytes = new Uint8Array(readFileSync(path));
    // Envelope framing for a child: "snap\0\x03\x01\x01" (8 bytes, flag=0x01)
    // followed by 64 bytes of parent hex. Flip one parent hex byte so the
    // header parentId becomes invalid/different, while the core bytes (and
    // thus the recomputed id) stay identical.
    const parentHexStart = 8;
    bytes[parentHexStart] = bytes[parentHexStart] === 0x61 /* 'a' */ ? 0x62 /* 'b' */ : 0x61;
    writeFileSync(path, bytes);

    expect(() => store.getSnapshot(child.id)).toThrow(CorruptObject);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ===========================================================================
// FsStore: listSnapshots preserves insertion order.
// ===========================================================================

describe("C8 FsStore: listSnapshots preserves insertion order", () => {
  it("returns ids in insertion order, not lexicographic order, across reverse-lexicographic inserts", async () => {
    const dir = freshDir("fs-order");
    const store = new FsStore(dir);
    // Build three snapshots whose ids sort reverse-lexicographically relative
    // to insertion order. We cannot control ids directly, so insert several
    // snapshots and assert the returned order equals insertion order, not the
    // sorted order. To make the distinction meaningful, use distinct trees so
    // the ids are distinct.
    const ids: SnapshotId[] = [];
    for (let i = 0; i < 5; i++) {
      const tree = makeTree(null, new Map([[`f${i}.txt`, asHash(String(i).repeat(64))]]));
      const s = await createSnapshot(null, tree, 10 + i, `snap-${i}`, false);
      store.putSnapshot(toSnapshotEnvelope(s));
      ids.push(s.id);
    }
    const listed = store.listSnapshots();
    expect(listed).toEqual(ids);
    // And it is NOT the lexicographic sort (assert the distinction is real).
    const sorted = [...ids].sort();
    expect(listed).not.toEqual(sorted);
    rmSync(dir, { recursive: true, force: true });
  });

  it("preserves insertion order across a process restart (re-construct on the same dir)", async () => {
    const dir = freshDir("fs-order-restart");
    const store = new FsStore(dir);
    const ids: SnapshotId[] = [];
    for (let i = 0; i < 4; i++) {
      const tree = makeTree(null, new Map([[`g${i}.txt`, asHash(String(i + 1).repeat(64))]]));
      const s = await createSnapshot(null, tree, 100 + i, `r-${i}`, false);
      store.putSnapshot(toSnapshotEnvelope(s));
      ids.push(s.id);
    }
    // Simulate a restart by constructing a fresh FsStore on the same dir.
    const reopened = new FsStore(dir);
    expect(reopened.listSnapshots()).toEqual(ids);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ===========================================================================
// FsStore: strict ContentObject length validation (non-canonical lengths).
// ===========================================================================

describe("C8 FsStore: ContentObject rejects non-canonical length fields", () => {
  /** Serialize a blob, then rewrite the length field to a non-canonical form. */
  async function makeBlobWithLengthField(lenStr: string): Promise<{ dir: string; id: Hash }> {
    const dir = freshDir("fs-lenfield");
    const store = new FsStore(dir);
    const content = "hello";
    const obj = await createContentObject("blob", enc.encode(content));
    store.putObject(obj);
    // Framing: "content"(7)\0 magic(1) ver(1) kindTag(1) <len>\0 <bytes> \0 <id-hex(64)>
    // The length field starts at offset 7+1+3 = 11 and runs to the next NUL.
    const path = join(dir, "objects", obj.id);
    const bytes = new Uint8Array(readFileSync(path));
    // Find the NUL terminating the length field (first NUL at/after offset 11).
    let nul = -1;
    for (let i = 11; i < bytes.length; i++) {
      if (bytes[i] === 0) { nul = i; break; }
    }
    expect(nul).toBeGreaterThan(11);
    const oldLenStr = dec.decode(bytes.subarray(11, nul));
    const newLenBytes = enc.encode(lenStr);
    // Rebuild the file with the replaced length field. The body bytes and
    // trailing id-hex remain in place; only the length field changes length.
    const before = bytes.subarray(0, 11);
    const after = bytes.subarray(nul); // includes the NUL + body + id-hex
    const rebuilt = new Uint8Array(before.length + newLenBytes.length + after.length);
    rebuilt.set(before, 0);
    rebuilt.set(newLenBytes, before.length);
    rebuilt.set(after, before.length + newLenBytes.length);
    writeFileSync(path, rebuilt);
    return { dir, id: obj.id };
  }

  it("rejects a leading-zero length (007)", async () => {
    const { dir, id } = await makeBlobWithLengthField("007");
    const store = new FsStore(dir);
    expect(() => store.getObject(id)).toThrow(CorruptObject);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a length with trailing junk (5x)", async () => {
    const { dir, id } = await makeBlobWithLengthField("5x");
    const store = new FsStore(dir);
    expect(() => store.getObject(id)).toThrow(CorruptObject);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a signed length (+5)", async () => {
    const { dir, id } = await makeBlobWithLengthField("+5");
    const store = new FsStore(dir);
    expect(() => store.getObject(id)).toThrow(CorruptObject);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an empty length field", async () => {
    const { dir, id } = await makeBlobWithLengthField("");
    const store = new FsStore(dir);
    expect(() => store.getObject(id)).toThrow(CorruptObject);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ===========================================================================
// FsStore: ManifestRefs JSON strict validation.
// ===========================================================================

describe("C8 FsStore: ManifestRefs JSON strict validation", () => {
  /** Write a raw manifest-refs JSON file for `sid` under `dir`. */
  function writeRefsJson(dir: string, sid: SnapshotId, json: string): void {
    mkdirSync(join(dir, "manifest-refs"), { recursive: true });
    writeFileSync(join(dir, "manifest-refs", `${sid}.json`), json);
  }

  it("rejects a missing publicManifestRef field", () => {
    const dir = freshDir("fs-refs-missing-pub");
    const store = new FsStore(dir);
    const sid = asSnapshotId("1".repeat(64));
    writeRefsJson(dir, sid, JSON.stringify({ privateManifestRef: null }));
    expect(() => store.getManifestRefs(sid)).toThrow(CorruptObject);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a missing privateManifestRef field", () => {
    const dir = freshDir("fs-refs-missing-priv");
    const store = new FsStore(dir);
    const sid = asSnapshotId("2".repeat(64));
    writeRefsJson(dir, sid, JSON.stringify({ publicManifestRef: null }));
    expect(() => store.getManifestRefs(sid)).toThrow(CorruptObject);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an invalid (non-hash) publicManifestRef string", () => {
    const dir = freshDir("fs-refs-bad-pub");
    const store = new FsStore(dir);
    const sid = asSnapshotId("3".repeat(64));
    writeRefsJson(dir, sid, JSON.stringify({ publicManifestRef: "not-a-hash", privateManifestRef: null }));
    expect(() => store.getManifestRefs(sid)).toThrow(CorruptObject);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an invalid (wrong-length) privateManifestRef string", () => {
    const dir = freshDir("fs-refs-bad-priv");
    const store = new FsStore(dir);
    const sid = asSnapshotId("4".repeat(64));
    writeRefsJson(dir, sid, JSON.stringify({ publicManifestRef: null, privateManifestRef: "abc" }));
    expect(() => store.getManifestRefs(sid)).toThrow(CorruptObject);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a non-object JSON (array)", () => {
    const dir = freshDir("fs-refs-array");
    const store = new FsStore(dir);
    const sid = asSnapshotId("5".repeat(64));
    writeRefsJson(dir, sid, "[1,2,3]");
    expect(() => store.getManifestRefs(sid)).toThrow(CorruptObject);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a non-object JSON (null)", () => {
    const dir = freshDir("fs-refs-null");
    const store = new FsStore(dir);
    const sid = asSnapshotId("6".repeat(64));
    writeRefsJson(dir, sid, "null");
    expect(() => store.getManifestRefs(sid)).toThrow(CorruptObject);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a number where a hash is expected", () => {
    const dir = freshDir("fs-refs-number");
    const store = new FsStore(dir);
    const sid = asSnapshotId("7".repeat(64));
    writeRefsJson(dir, sid, JSON.stringify({ publicManifestRef: 123, privateManifestRef: null }));
    expect(() => store.getManifestRefs(sid)).toThrow(CorruptObject);
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts both fields null (canonical empty refs)", () => {
    const dir = freshDir("fs-refs-both-null");
    const store = new FsStore(dir);
    const sid = asSnapshotId("8".repeat(64));
    writeRefsJson(dir, sid, JSON.stringify({ publicManifestRef: null, privateManifestRef: null }));
    expect(store.getManifestRefs(sid)).toEqual({
      publicManifestRef: null,
      privateManifestRef: null,
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts both fields as valid SHA-256 hashes", () => {
    const dir = freshDir("fs-refs-both-hash");
    const store = new FsStore(dir);
    const sid = asSnapshotId("9".repeat(64));
    writeRefsJson(dir, sid, JSON.stringify({
      publicManifestRef: "a".repeat(64),
      privateManifestRef: "b".repeat(64),
    }));
    expect(store.getManifestRefs(sid)).toEqual({
      publicManifestRef: asHash("a".repeat(64)),
      privateManifestRef: asHash("b".repeat(64)),
    });
    rmSync(dir, { recursive: true, force: true });
  });
});
