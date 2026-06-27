// C2 in-memory Store backend: `Map`-backed reference implementation.
//
// Separate maps keep the three immutable graphs (content objects, signed ACL
// nodes, snapshot envelopes) and the one mutable attachment (manifest refs)
// isolated. Byte-bearing values are copied at the store boundary on both put
// and get, so callers cannot mutate stored data through aliased references and
// stored data cannot mutate a caller's buffer after the call returns. The
// `permissions` set on an ACL record is likewise cloned.
//
// `copyBytes` uses `new Uint8Array(bytes)` (a non-virtual copy) so that a
// `Buffer`-backed `Uint8Array` input cannot alias the store's stored/returned
// bytes — `Uint8Array.prototype.slice()` returns a view that shares the same
// underlying `ArrayBuffer` when the source is a `Buffer`, which would let a
// caller mutate stored state through the original `Buffer`.
//
// Immutability/conflict semantics:
//   - `putObject`: same `id` + identical `kind` + `bytes` → idempotent no-op;
//     same `id` + different `kind` and/or `bytes` → `ObjectConflict` (the
//     content graph is append-only; the stored object is never replaced).
//   - `putAcl`: same `id` + identical `subject`/`object`/`permissions` +
//     `signature` → idempotent no-op; same `id` + different immutable data →
//     `AclConflict` (the ACL metadata graph is append-only; the stored node is
//     never replaced).
//   - `putSnapshot`: same `SnapshotId` + identical `parentId` + identical
//     `serializedBytes` → idempotent no-op; same `SnapshotId` + different
//     `parentId` and/or `serializedBytes` → `SnapshotConflict` (the immutable
//     envelope is append-only).
//
// `putManifestRefs` is the sole upsert surface: it overwrites the attachment
// for a `SnapshotId` with changed refs, is idempotent for identical refs, and
// never touches the immutable `SnapshotEnvelope`. There are no delete methods.

import type { AclNodeId, Hash, SnapshotId } from "../core/ids.ts";
import type { ContentObject } from "../core/object.ts";
import type { Permission, SignedAclNode } from "../core/acl.ts";
import type { SnapshotEnvelope } from "../core/snapshot-contract.ts";
import { AclConflict, NotFound, ObjectConflict, SnapshotConflict, type ManifestRefs, type Store } from "./store.ts";

/**
 * Copy a byte buffer so the caller and the store never alias the same memory.
 * Uses `new Uint8Array(bytes)` (a non-virtual copy) rather than
 * `bytes.slice()`: `slice()` on a `Buffer`-backed `Uint8Array` returns a view
 * that shares the source `ArrayBuffer`, so a later mutation of the caller's
 * `Buffer` would mutate the stored bytes. `new Uint8Array(bytes)` always
 * allocates a fresh `ArrayBuffer` and copies element-by-element.
 */
function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

/** Byte-for-byte equality of two `Uint8Array`s (same length + contents). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Deep-copy a `ContentObject` so stored values are independent of caller buffers. */
function cloneContentObject(obj: ContentObject): ContentObject {
  return {
    id: obj.id,
    kind: obj.kind,
    bytes: copyBytes(obj.bytes),
  };
}

/** Deep-copy a `SignedAclNode`, cloning the signature and the permissions set. */
function cloneSignedAclNode(node: SignedAclNode): SignedAclNode {
  return {
    id: node.id,
    record: {
      subject: node.record.subject,
      object: node.record.object,
      permissions: new Set<Permission>(node.record.permissions),
    },
    signature: copyBytes(node.signature),
  };
}

/** Deep-copy a `SnapshotEnvelope`, cloning the immutable core bytes. */
function cloneSnapshotEnvelope(env: SnapshotEnvelope): SnapshotEnvelope {
  return {
    id: env.id,
    parentId: env.parentId,
    serializedBytes: copyBytes(env.serializedBytes),
  };
}

/** Structural equality of two `ManifestRefs` (both `Hash | null` fields match). */
function manifestRefsEqual(a: ManifestRefs, b: ManifestRefs): boolean {
  return a.publicManifestRef === b.publicManifestRef &&
    a.privateManifestRef === b.privateManifestRef;
}

/** Structural equality of two `ContentObject` envelopes (same kind + bytes). */
function contentObjectEqual(a: ContentObject, b: ContentObject): boolean {
  return a.kind === b.kind && bytesEqual(a.bytes, b.bytes);
}

/** Structural equality of two `SignedAclNode`s (same record + signature). */
function signedAclNodeEqual(a: SignedAclNode, b: SignedAclNode): boolean {
  return a.record.subject === b.record.subject &&
    a.record.object === b.record.object &&
    a.record.permissions.size === b.record.permissions.size &&
    Array.from(a.record.permissions).every((p) => b.record.permissions.has(p)) &&
    bytesEqual(a.signature, b.signature);
}

/**
 * `Map`-backed in-memory `Store`. All state lives in four `Map`s:
 *   - `objects`: immutable `ContentObject` envelopes keyed by content `Hash`.
 *   - `acls`: immutable signed ACL nodes keyed by `AclNodeId`.
 *   - `snapshots`: immutable `SnapshotEnvelope`s keyed by `SnapshotId`.
 *   - `manifestRefs`: mutable `ManifestRefs` attachment keyed by `SnapshotId`.
 *
 * `Map` preserves insertion order, so `listSnapshots` returns ids in the order
 * their envelopes were first stored.
 */
export class MemoryStore implements Store {
  private readonly objects = new Map<Hash, ContentObject>();
  private readonly acls = new Map<AclNodeId, SignedAclNode>();
  private readonly snapshots = new Map<SnapshotId, SnapshotEnvelope>();
  private readonly manifestRefs = new Map<SnapshotId, ManifestRefs>();

  // --- Content graph ---

  putObject(obj: ContentObject): void {
    const existing = this.objects.get(obj.id);
    if (existing !== undefined) {
      // Append-only/idempotent: identical immutable data is a no-op; differing
      // kind and/or bytes is a conflict. The stored object is never replaced.
      if (contentObjectEqual(existing, obj)) {
        return;
      }
      throw new ObjectConflict(
        obj.id,
        `ObjectConflict: object ${obj.id} already exists with different immutable data`,
      );
    }
    // Always store a clone so a later mutation of the caller's buffer cannot
    // reach the stored value.
    this.objects.set(obj.id, cloneContentObject(obj));
  }

  getObject(id: Hash): ContentObject {
    const stored = this.objects.get(id);
    if (stored === undefined) {
      throw new NotFound("object", id);
    }
    // Return a clone so callers cannot mutate the stored bytes through the
    // returned reference.
    return cloneContentObject(stored);
  }

  hasObject(id: Hash): boolean {
    return this.objects.has(id);
  }

  // --- ACL metadata graph ---

  putAcl(node: SignedAclNode): void {
    const existing = this.acls.get(node.id);
    if (existing !== undefined) {
      // Append-only/idempotent: identical immutable data is a no-op; differing
      // subject/object/permissions and/or signature is a conflict. The stored
      // node is never replaced.
      if (signedAclNodeEqual(existing, node)) {
        return;
      }
      throw new AclConflict(
        node.id,
        `AclConflict: ACL node ${node.id} already exists with different immutable data`,
      );
    }
    this.acls.set(node.id, cloneSignedAclNode(node));
  }

  getAcl(id: AclNodeId): SignedAclNode {
    const stored = this.acls.get(id);
    if (stored === undefined) {
      throw new NotFound("acl", id);
    }
    return cloneSignedAclNode(stored);
  }

  // --- Immutable snapshot envelopes ---

  putSnapshot(env: SnapshotEnvelope): void {
    const existing = this.snapshots.get(env.id);
    if (existing !== undefined) {
      // Append-only/idempotent: identical core envelope is a no-op; a
      // differing core envelope (parentId and/or serializedBytes) is a
      // conflict. We compare the immutable core fields only — the id is the
      // same by definition here.
      const sameParent = existing.parentId === env.parentId;
      const sameBytes = bytesEqual(existing.serializedBytes, env.serializedBytes);
      if (sameParent && sameBytes) {
        return;
      }
      throw new SnapshotConflict(
        env.id,
        `SnapshotConflict: SnapshotId ${env.id} already exists with different immutable core bytes`,
      );
    }
    this.snapshots.set(env.id, cloneSnapshotEnvelope(env));
  }

  getSnapshot(id: SnapshotId): SnapshotEnvelope {
    const stored = this.snapshots.get(id);
    if (stored === undefined) {
      throw new NotFound("snapshot", id);
    }
    return cloneSnapshotEnvelope(stored);
  }

  listSnapshots(): SnapshotId[] {
    // Map iteration yields keys in insertion order.
    return Array.from(this.snapshots.keys());
  }

  // --- Mutable manifest-ref attachment ---

  putManifestRefs(snapshotId: SnapshotId, refs: ManifestRefs): void {
    const current = this.manifestRefs.get(snapshotId);
    if (current !== undefined && manifestRefsEqual(current, refs)) {
      // Idempotent: identical refs are a no-op.
      return;
    }
    // Upsert: store a fresh record. `ManifestRefs` carries only `Hash | null`
    // (immutable branded strings or null), so no byte copy is needed.
    this.manifestRefs.set(snapshotId, {
      publicManifestRef: refs.publicManifestRef,
      privateManifestRef: refs.privateManifestRef,
    });
  }

  getManifestRefs(snapshotId: SnapshotId): ManifestRefs {
    const stored = this.manifestRefs.get(snapshotId);
    if (stored === undefined) {
      // Default per spec: both refs null when nothing has been attached.
      return { publicManifestRef: null, privateManifestRef: null };
    }
    return {
      publicManifestRef: stored.publicManifestRef,
      privateManifestRef: stored.privateManifestRef,
    };
  }
}
