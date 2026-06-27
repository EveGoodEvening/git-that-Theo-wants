// C2 unit tests: in-memory Store backend over the C1 object model.
//
// Covers: ContentObject round-trip (both kinds); ACL signed-node round-trip;
// SnapshotEnvelope round-trip; typed `NotFound` for missing lookups;
// `putSnapshot` idempotent/conflict semantics; `putManifestRefs` upsert +
// idempotent + snapshot-envelope-bytes-unchanged; boundary copy isolation
// (caller cannot mutate stored bytes); no real-FS writes.

import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asAclNodeId,
  asActorId,
  asHash,
  asSnapshotId,
  type Hash,
  type SnapshotId,
  sha256,
} from "../../src/core/ids.ts";
import {
  createContentObject,
  type ContentObject,
} from "../../src/core/object.ts";
import { createSignedAclNode, type Permission } from "../../src/core/acl.ts";
import type { SnapshotEnvelope } from "../../src/core/snapshot-contract.ts";
import { MemoryStore } from "../../src/store/memory-store.ts";
import { AclConflict, NotFound, ObjectConflict, SnapshotConflict, type Store } from "../../src/store/store.ts";

const KEY = new TextEncoder().encode("local-stub-key-not-production");

async function makeObject(kind: "blob" | "secret-blob", text: string): Promise<ContentObject> {
  return createContentObject(kind, new TextEncoder().encode(text));
}

async function makeAcl(perms: Permission[] = ["read", "write"]): Promise<{
  node: Awaited<ReturnType<typeof createSignedAclNode>>;
}> {
  const node = await createSignedAclNode(
    {
      subject: asActorId("actor-alice"),
      object: asHash("a".repeat(64)),
      permissions: new Set<Permission>(perms),
    },
    KEY,
  );
  return { node };
}

function makeEnvelope(idHex: string, parentIdHex: string | null, core: string): SnapshotEnvelope {
  return {
    id: asSnapshotId(idHex),
    parentId: parentIdHex === null ? null : asSnapshotId(parentIdHex),
    serializedBytes: new TextEncoder().encode(core),
  };
}

const SNAP_A = "a".repeat(64);
const SNAP_B = "b".repeat(64);
const SNAP_C = "c".repeat(64);

describe.each([MemoryStore] as const)("C2 %s", (StoreCtor) => {
  function makeStore(): Store {
    return new StoreCtor();
  }

  describe("ContentObject round-trip", () => {
    it("stores and retrieves a `blob` ContentObject", async () => {
      const store = makeStore();
      const obj = await makeObject("blob", "hello world");
      store.putObject(obj);
      expect(store.hasObject(obj.id)).toBe(true);
      const got = store.getObject(obj.id);
      expect(got.id).toBe(obj.id);
      expect(got.kind).toBe("blob");
      expect(new TextDecoder().decode(got.bytes)).toBe("hello world");
    });

    it("stores and retrieves a `secret-blob` ContentObject", async () => {
      const store = makeStore();
      const obj = await makeObject("secret-blob", "ciphertext-payload");
      store.putObject(obj);
      expect(store.hasObject(obj.id)).toBe(true);
      const got = store.getObject(obj.id);
      expect(got.kind).toBe("secret-blob");
      expect(new TextDecoder().decode(got.bytes)).toBe("ciphertext-payload");
    });

    it("putObject is idempotent for an identical object", async () => {
      const store = makeStore();
      const a = await makeObject("blob", "same");
      const b = await makeObject("blob", "same");
      expect(a.id).toBe(b.id);
      store.putObject(a);
      store.putObject(b); // no throw
      expect(store.hasObject(a.id)).toBe(true);
    });

    it("getObject on a missing id throws typed NotFound", () => {
      const store = makeStore();
      const missing = asHash("0".repeat(64));
      try {
        store.getObject(missing);
        throw new Error("expected NotFound");
      } catch (e) {
        expect(e).toBeInstanceOf(NotFound);
        expect((e as NotFound).kind).toBe("object");
        expect((e as NotFound).key).toBe(missing);
      }
    });

    it("hasObject returns false for a missing id", () => {
      const store = makeStore();
      expect(store.hasObject(asHash("1".repeat(64)))).toBe(false);
    });

    it("does not alias stored bytes to the caller's buffer", async () => {
      const store = makeStore();
      const bytes = new TextEncoder().encode("mutable");
      const obj = await createContentObject("blob", bytes);
      store.putObject(obj);
      // Mutate the original buffer after the put.
      bytes[0] = 0x5a;
      const got = store.getObject(obj.id);
      expect(new TextDecoder().decode(got.bytes)).toBe("mutable");
    });

    it("does not alias returned bytes to stored bytes", async () => {
      const store = makeStore();
      const obj = await makeObject("blob", "original");
      store.putObject(obj);
      const got = store.getObject(obj.id);
      got.bytes[0] = 0x5a;
      const got2 = store.getObject(obj.id);
      expect(new TextDecoder().decode(got2.bytes)).toBe("original");
    });

    it("does not alias stored bytes when input is a Buffer (Buffer.from regression)", async () => {
      const store = makeStore();
      const buf = Buffer.from("buffered-mutable");
      const obj = await createContentObject("blob", buf);
      store.putObject(obj);
      // Mutate the original Buffer after the put.
      buf[0] = 0x5a;
      const got = store.getObject(obj.id);
      expect(new TextDecoder().decode(got.bytes)).toBe("buffered-mutable");
    });

    it("does not alias returned bytes to stored bytes when the get result is Buffer-backed", async () => {
      const store = makeStore();
      const obj = await makeObject("blob", "buffered-original");
      store.putObject(obj);
      const got = store.getObject(obj.id);
      // If the store returned a Buffer view over its internal ArrayBuffer,
      // mutating got.bytes would corrupt the stored copy.
      got.bytes[0] = 0x5a;
      const got2 = store.getObject(obj.id);
      expect(new TextDecoder().decode(got2.bytes)).toBe("buffered-original");
    });

    it("same id with different kind is rejected with ObjectConflict and stored value unchanged", async () => {
      const store = makeStore();
      const blob = await makeObject("blob", "payload");
      store.putObject(blob);
      // Same content bytes → same id, but a different kind tag. Construct
      // directly so createContentObject is bypassed (it would recompute id).
      const conflict: ContentObject = {
        id: blob.id,
        kind: "secret-blob",
        bytes: blob.bytes.slice(),
      };
      try {
        store.putObject(conflict);
        throw new Error("expected ObjectConflict");
      } catch (e) {
        expect(e).toBeInstanceOf(ObjectConflict);
        expect((e as ObjectConflict).id).toBe(blob.id);
      }
      const got = store.getObject(blob.id);
      expect(got.kind).toBe("blob");
      expect(new TextDecoder().decode(got.bytes)).toBe("payload");
    });

    it("same id with different bytes is rejected with ObjectConflict and stored value unchanged", async () => {
      const store = makeStore();
      const a = await makeObject("blob", "first");
      store.putObject(a);
      // Forcibly reuse the id with different bytes (content-addressing would
      // normally prevent this; the store must defend against it regardless).
      const conflict: ContentObject = {
        id: a.id,
        kind: "blob",
        bytes: new TextEncoder().encode("second"),
      };
      try {
        store.putObject(conflict);
        throw new Error("expected ObjectConflict");
      } catch (e) {
        expect(e).toBeInstanceOf(ObjectConflict);
      }
      const got = store.getObject(a.id);
      expect(new TextDecoder().decode(got.bytes)).toBe("first");
    });
  });

  describe("ACL signed-node round-trip", () => {
    it("stores and retrieves a signed ACL node", async () => {
      const store = makeStore();
      const { node } = await makeAcl(["read", "write", "publish"]);
      store.putAcl(node);
      const got = store.getAcl(node.id);
      expect(got.id).toBe(node.id);
      expect(got.record.subject).toBe(node.record.subject);
      expect(got.record.object).toBe(node.record.object);
      expect(got.record.permissions).toEqual(node.record.permissions);
      expect(Array.from(got.signature)).toEqual(Array.from(node.signature));
    });

    it("putAcl is idempotent for an identical node", async () => {
      const store = makeStore();
      const { node } = await makeAcl(["read"]);
      store.putAcl(node);
      store.putAcl(node); // no throw
      expect(store.getAcl(node.id).id).toBe(node.id);
    });

    it("getAcl on a missing id throws typed NotFound", () => {
      const store = makeStore();
      const missing = asAclNodeId("2".repeat(64));
      try {
        store.getAcl(missing);
        throw new Error("expected NotFound");
      } catch (e) {
        expect(e).toBeInstanceOf(NotFound);
        expect((e as NotFound).kind).toBe("acl");
        expect((e as NotFound).key).toBe(missing);
      }
    });

    it("does not alias stored signature/permissions to the caller's buffers", async () => {
      const store = makeStore();
      const { node } = await makeAcl(["read", "write"]);
      store.putAcl(node);
      // Mutate caller-side references.
      node.signature[0] = 0xff;
      node.record.permissions.add("publish");
      const got = store.getAcl(node.id);
      expect(Array.from(got.signature)).not.toContain(0xff);
      expect(got.record.permissions.has("publish")).toBe(false);
    });

    it("does not alias stored signature when input signature is a Buffer (Buffer.from regression)", async () => {
      const store = makeStore();
      const { node } = await makeAcl(["read", "write"]);
      // Re-sign with a Buffer-backed signature to exercise the Buffer aliasing
      // path on put. We build a node whose signature is a Buffer view.
      const sigBuf = Buffer.from(node.signature);
      const bufNode = {
        id: node.id,
        record: {
          subject: node.record.subject,
          object: node.record.object,
          permissions: new Set<Permission>(node.record.permissions),
        },
        signature: sigBuf,
      };
      store.putAcl(bufNode);
      // Mutate the original Buffer after the put.
      sigBuf[0] = 0xff;
      const got = store.getAcl(node.id);
      expect(Array.from(got.signature)).not.toContain(0xff);
      expect(Array.from(got.signature)).toEqual(Array.from(node.signature));
    });

    it("same id with different signature is rejected with AclConflict and stored value unchanged", async () => {
      const store = makeStore();
      const { node } = await makeAcl(["read", "write"]);
      store.putAcl(node);
      // Same id, same record, but a different signature.
      const tamperedSig = node.signature.slice();
      tamperedSig[0] = (tamperedSig[0] ?? 0) ^ 0xff;
      const conflict = {
        id: node.id,
        record: {
          subject: node.record.subject,
          object: node.record.object,
          permissions: new Set<Permission>(node.record.permissions),
        },
        signature: tamperedSig,
      };
      try {
        store.putAcl(conflict);
        throw new Error("expected AclConflict");
      } catch (e) {
        expect(e).toBeInstanceOf(AclConflict);
        expect((e as AclConflict).id).toBe(node.id);
      }
      const got = store.getAcl(node.id);
      expect(Array.from(got.signature)).toEqual(Array.from(node.signature));
    });

    it("same id with different permissions is rejected with AclConflict and stored value unchanged", async () => {
      const store = makeStore();
      const { node } = await makeAcl(["read", "write"]);
      store.putAcl(node);
      // Same id + signature shape but a different permission set. The store
      // compares the full immutable record, so this must conflict.
      const conflict = {
        id: node.id,
        record: {
          subject: node.record.subject,
          object: node.record.object,
          permissions: new Set<Permission>(["read", "write", "publish"]),
        },
        signature: node.signature.slice(),
      };
      try {
        store.putAcl(conflict);
        throw new Error("expected AclConflict");
      } catch (e) {
        expect(e).toBeInstanceOf(AclConflict);
      }
      const got = store.getAcl(node.id);
      expect(Array.from(got.record.permissions).sort()).toEqual(["read", "write"]);
    });
  });

  describe("SnapshotEnvelope round-trip", () => {
    it("stores and retrieves a root envelope (parentId null)", () => {
      const store = makeStore();
      const env = makeEnvelope(SNAP_A, null, "core state A");
      store.putSnapshot(env);
      const got = store.getSnapshot(asSnapshotId(SNAP_A));
      expect(got.id).toBe(env.id);
      expect(got.parentId).toBeNull();
      expect(new TextDecoder().decode(got.serializedBytes)).toBe("core state A");
    });

    it("stores and retrieves a non-root envelope (parentId present)", () => {
      const store = makeStore();
      const env = makeEnvelope(SNAP_B, SNAP_A, "core state B");
      store.putSnapshot(env);
      const got = store.getSnapshot(asSnapshotId(SNAP_B));
      expect(got.parentId).toBe(asSnapshotId(SNAP_A));
      expect(new TextDecoder().decode(got.serializedBytes)).toBe("core state B");
    });

    it("getSnapshot on a missing id throws typed NotFound", () => {
      const store = makeStore();
      const missing = asSnapshotId("3".repeat(64));
      try {
        store.getSnapshot(missing);
        throw new Error("expected NotFound");
      } catch (e) {
        expect(e).toBeInstanceOf(NotFound);
        expect((e as NotFound).kind).toBe("snapshot");
        expect((e as NotFound).key).toBe(missing);
      }
    });

    it("listSnapshots returns ids in insertion order", () => {
      const store = makeStore();
      store.putSnapshot(makeEnvelope(SNAP_A, null, "a"));
      store.putSnapshot(makeEnvelope(SNAP_B, SNAP_A, "b"));
      store.putSnapshot(makeEnvelope(SNAP_C, SNAP_B, "c"));
      expect(store.listSnapshots()).toEqual([
        asSnapshotId(SNAP_A),
        asSnapshotId(SNAP_B),
        asSnapshotId(SNAP_C),
      ]);
    });

    it("duplicate putSnapshot of identical envelope is idempotent", () => {
      const store = makeStore();
      const env = makeEnvelope(SNAP_A, null, "core");
      store.putSnapshot(env);
      store.putSnapshot(env); // no throw
      store.putSnapshot(makeEnvelope(SNAP_A, null, "core")); // equal copy also idempotent
      expect(store.listSnapshots()).toEqual([asSnapshotId(SNAP_A)]);
    });

    it("same SnapshotId with different serializedBytes is rejected with SnapshotConflict", () => {
      const store = makeStore();
      store.putSnapshot(makeEnvelope(SNAP_A, null, "core one"));
      try {
        store.putSnapshot(makeEnvelope(SNAP_A, null, "core two"));
        throw new Error("expected SnapshotConflict");
      } catch (e) {
        expect(e).toBeInstanceOf(SnapshotConflict);
        expect((e as SnapshotConflict).snapshotId).toBe(asSnapshotId(SNAP_A));
      }
      // Stored envelope is unchanged after the rejected put.
      const got = store.getSnapshot(asSnapshotId(SNAP_A));
      expect(new TextDecoder().decode(got.serializedBytes)).toBe("core one");
    });

    it("same SnapshotId with different parentId is rejected with SnapshotConflict", () => {
      const store = makeStore();
      store.putSnapshot(makeEnvelope(SNAP_A, null, "core"));
      try {
        store.putSnapshot(makeEnvelope(SNAP_A, SNAP_B, "core"));
        throw new Error("expected SnapshotConflict");
      } catch (e) {
        expect(e).toBeInstanceOf(SnapshotConflict);
      }
      expect(store.getSnapshot(asSnapshotId(SNAP_A)).parentId).toBeNull();
    });

    it("does not alias stored serializedBytes to the caller's buffer", () => {
      const store = makeStore();
      const bytes = new TextEncoder().encode("core");
      const env: SnapshotEnvelope = {
        id: asSnapshotId(SNAP_A),
        parentId: null,
        serializedBytes: bytes,
      };
      store.putSnapshot(env);
      bytes[0] = 0x5a;
      const got = store.getSnapshot(asSnapshotId(SNAP_A));
      expect(new TextDecoder().decode(got.serializedBytes)).toBe("core");
    });

    it("does not alias returned serializedBytes to stored bytes", () => {
      const store = makeStore();
      store.putSnapshot(makeEnvelope(SNAP_A, null, "core"));
      const got = store.getSnapshot(asSnapshotId(SNAP_A));
      got.serializedBytes[0] = 0x5a;
      const got2 = store.getSnapshot(asSnapshotId(SNAP_A));
      expect(new TextDecoder().decode(got2.serializedBytes)).toBe("core");
    });

    it("does not alias stored serializedBytes when input is a Buffer (Buffer.from regression)", () => {
      const store = makeStore();
      const buf = Buffer.from("buffered-core");
      const env: SnapshotEnvelope = {
        id: asSnapshotId(SNAP_A),
        parentId: null,
        serializedBytes: buf,
      };
      store.putSnapshot(env);
      // Mutate the original Buffer after the put.
      buf[0] = 0x5a;
      const got = store.getSnapshot(asSnapshotId(SNAP_A));
      expect(new TextDecoder().decode(got.serializedBytes)).toBe("buffered-core");
    });

    it("does not alias returned serializedBytes to stored bytes when the get result is Buffer-backed", () => {
      const store = makeStore();
      store.putSnapshot(makeEnvelope(SNAP_A, null, "buffered-core-original"));
      const got = store.getSnapshot(asSnapshotId(SNAP_A));
      got.serializedBytes[0] = 0x5a;
      const got2 = store.getSnapshot(asSnapshotId(SNAP_A));
      expect(new TextDecoder().decode(got2.serializedBytes)).toBe("buffered-core-original");
    });
  });

  describe("ManifestRefs attachment", () => {
    it("getManifestRefs returns both null when nothing has been stored", () => {
      const store = makeStore();
      const refs = store.getManifestRefs(asSnapshotId(SNAP_A));
      expect(refs.publicManifestRef).toBeNull();
      expect(refs.privateManifestRef).toBeNull();
    });

    it("putManifestRefs upserts refs for a SnapshotId", async () => {
      const store = makeStore();
      const snapId = asSnapshotId(SNAP_A);
      const pub = await sha256(new TextEncoder().encode("pub"));
      const priv = await sha256(new TextEncoder().encode("priv"));
      store.putManifestRefs(snapId, {
        publicManifestRef: pub,
        privateManifestRef: priv,
      });
      const got = store.getManifestRefs(snapId);
      expect(got.publicManifestRef).toBe(pub);
      expect(got.privateManifestRef).toBe(priv);
    });

    it("putManifestRefs overwrites changed refs for the same SnapshotId", async () => {
      const store = makeStore();
      const snapId = asSnapshotId(SNAP_A);
      const pub1 = await sha256(new TextEncoder().encode("pub1"));
      const priv1 = await sha256(new TextEncoder().encode("priv1"));
      store.putManifestRefs(snapId, {
        publicManifestRef: pub1,
        privateManifestRef: priv1,
      });
      const pub2 = await sha256(new TextEncoder().encode("pub2"));
      store.putManifestRefs(snapId, {
        publicManifestRef: pub2,
        privateManifestRef: priv1, // unchanged
      });
      const got = store.getManifestRefs(snapId);
      expect(got.publicManifestRef).toBe(pub2);
      expect(got.privateManifestRef).toBe(priv1);
    });

    it("putManifestRefs is idempotent for identical refs", async () => {
      const store = makeStore();
      const snapId = asSnapshotId(SNAP_A);
      const pub = await sha256(new TextEncoder().encode("pub"));
      const priv = await sha256(new TextEncoder().encode("priv"));
      const refs = { publicManifestRef: pub, privateManifestRef: priv };
      store.putManifestRefs(snapId, refs);
      store.putManifestRefs(snapId, refs); // no throw
      const got = store.getManifestRefs(snapId);
      expect(got).toEqual(refs);
    });

    it("supports null refs in either field", async () => {
      const store = makeStore();
      const snapId = asSnapshotId(SNAP_A);
      const pub = await sha256(new TextEncoder().encode("pub"));
      store.putManifestRefs(snapId, {
        publicManifestRef: pub,
        privateManifestRef: null,
      });
      const got = store.getManifestRefs(snapId);
      expect(got.publicManifestRef).toBe(pub);
      expect(got.privateManifestRef).toBeNull();
    });

    it("manifest-ref upserts do not change the immutable SnapshotEnvelope bytes", async () => {
      const store = makeStore();
      const snapId = asSnapshotId(SNAP_A);
      store.putSnapshot(makeEnvelope(SNAP_A, null, "immutable core"));
      const before = store.getSnapshot(snapId);
      const beforeBytes = before.serializedBytes.slice();
      const pub = await sha256(new TextEncoder().encode("pub"));
      const priv = await sha256(new TextEncoder().encode("priv"));
      store.putManifestRefs(snapId, { publicManifestRef: pub, privateManifestRef: priv });
      store.putManifestRefs(snapId, { publicManifestRef: pub, privateManifestRef: null });
      const after = store.getSnapshot(snapId);
      expect(Array.from(after.serializedBytes)).toEqual(Array.from(beforeBytes));
      expect(new TextDecoder().decode(after.serializedBytes)).toBe("immutable core");
      // Refs reflect the latest upsert.
      const refs = store.getManifestRefs(snapId);
      expect(refs.publicManifestRef).toBe(pub);
      expect(refs.privateManifestRef).toBeNull();
    });

    it("manifest refs can be attached before the snapshot envelope is stored", async () => {
      // The attachment index is independent of the snapshot envelope map; the
      // spec does not require the envelope to exist first.
      const store = makeStore();
      const snapId = asSnapshotId(SNAP_A);
      const pub = await sha256(new TextEncoder().encode("pub"));
      store.putManifestRefs(snapId, { publicManifestRef: pub, privateManifestRef: null });
      expect(store.getManifestRefs(snapId).publicManifestRef).toBe(pub);
      expect(store.listSnapshots()).toEqual([]);
    });
  });

  describe("no real-FS writes", () => {
    it("MemoryStore performs no filesystem writes", async () => {
      const dir = mkdtempSync(join(tmpdir(), "gtw-c2-"));
      const before = new Set(readdirSync(dir));
      const originalCwd = process.cwd();
      process.chdir(dir);
      try {
        const store = makeStore();
        const obj = await makeObject("blob", "no-fs");
        store.putObject(obj);
        const { node } = await makeAcl(["read"]);
        store.putAcl(node);
        store.putSnapshot(makeEnvelope(SNAP_A, null, "no-fs"));
        const pub = await sha256(new TextEncoder().encode("pub"));
        store.putManifestRefs(asSnapshotId(SNAP_A), {
          publicManifestRef: pub,
          privateManifestRef: null,
        });
        // Read it all back to exercise get paths too.
        store.getObject(obj.id);
        store.getAcl(node.id);
        store.getSnapshot(asSnapshotId(SNAP_A));
        store.getManifestRefs(asSnapshotId(SNAP_A));
        store.listSnapshots();
        const after = new Set(readdirSync(dir));
        // No new files/dirs created in the temp cwd.
        const created: string[] = [];
        for (const entry of after) if (!before.has(entry)) created.push(entry);
        expect(created).toEqual([]);
      } finally {
        process.chdir(originalCwd);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

// Suppress unused-import lint for types re-asserted at runtime boundaries.
void (undefined as unknown as Hash);
void (undefined as unknown as SnapshotId);
