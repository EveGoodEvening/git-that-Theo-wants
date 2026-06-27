// C2 pluggable Store interface: persistence seam over the C1 object model.
//
// The Store is crypto-agnostic and content-addressing-agnostic: it persists and
// retrieves the C1 contracts (`ContentObject`, `SignedAclNode`,
// `SnapshotEnvelope`) by their existing ids without re-deriving them. Per plan
// §2 decision 10, manifest refs are NOT embedded in the immutable
// `SnapshotEnvelope`; they live in a separate mutable `ManifestRefs` attachment
// keyed by `SnapshotId`, which is the sole upsert surface in an otherwise
// append-only store.
//
// Three typed errors are defined here:
//   - `NotFound`: a get/has lookup missed (returned instead of `undefined` so
//     callers cannot silently ignore a missing object).
//   - `ObjectConflict`: a `putObject` supplied the same content `Hash` as an
//     existing object but different immutable data (`kind` and/or `bytes`). The
//     content graph is append-only/idempotent; a conflicting re-put is rejected
//     rather than silently overwriting.
//   - `AclConflict`: a `putAcl` supplied the same `AclNodeId` as an existing
//     node but different immutable data (`subject`/`object`/`permissions` and/or
//     `signature`). The ACL metadata graph is append-only/idempotent; a
//     conflicting re-put is rejected rather than silently overwriting.
//   - `SnapshotConflict`: a `putSnapshot` supplied the same `SnapshotId` as an
//     existing envelope but different immutable core bytes (`serializedBytes`
//     or `parentId`). The immutable snapshot envelope is append-only/idempotent;
//     a conflicting re-put is rejected rather than silently overwriting.
//
// There are NO delete methods. Deletion/GC is deferred (plan §5, C2
// Blocker/Deferred): content-addressed objects, ACL nodes, and snapshot
// envelopes are append-only, and the manifest-ref attachment index has no
// delete method.

import type { AclNodeId, Hash, SnapshotId } from "../core/ids.ts";
import type { ContentObject } from "../core/object.ts";
import type { SignedAclNode } from "../core/acl.ts";
import type { SnapshotEnvelope } from "../core/snapshot-contract.ts";

/**
 * Typed error raised when a store lookup misses (object/acl/snapshot/manifest
 * refs absent). Returned instead of `undefined` so callers cannot accidentally
 * treat a missing object as a present-but-empty value.
 */
export class NotFound extends Error {
  readonly key: string;
  readonly kind:
    | "object"
    | "acl"
    | "snapshot"
    | "manifestRefs";

  constructor(
    kind: NotFound["kind"],
    key: string,
    message?: string,
  ) {
    super(message ?? `NotFound (${kind}): ${key}`);
    this.name = "NotFound";
    this.kind = kind;
    this.key = key;
  }
}

/**
 * Typed error raised when `putSnapshot` is called with a `SnapshotId` that
 * already exists but whose immutable core envelope (`parentId` and/or
 * `serializedBytes`) differs from the stored one. The immutable snapshot
 * envelope is append-only: an identical re-put is idempotent, a conflicting
 * re-put is rejected.
 */
export class SnapshotConflict extends Error {
  readonly snapshotId: SnapshotId;

  constructor(snapshotId: SnapshotId, message?: string) {
    super(
      message ??
        `SnapshotConflict: SnapshotId ${snapshotId} already exists with different immutable core bytes`,
    );
    this.name = "SnapshotConflict";
    this.snapshotId = snapshotId;
  }
}

/**
 * Typed error raised when `putObject` is called with a content `Hash` that
 * already exists but whose immutable data (`kind` and/or `bytes`) differs from
 * the stored object. The content graph is append-only: an identical re-put is
 * idempotent, a conflicting re-put is rejected.
 */
export class ObjectConflict extends Error {
  readonly id: Hash;

  constructor(id: Hash, message?: string) {
    super(
      message ??
        `ObjectConflict: object ${id} already exists with different immutable data`,
    );
    this.name = "ObjectConflict";
    this.id = id;
  }
}

/**
 * Typed error raised when `putAcl` is called with an `AclNodeId` that already
 * exists but whose immutable data (`subject`/`object`/`permissions` and/or
 * `signature`) differs from the stored node. The ACL metadata graph is
 * append-only: an identical re-put is idempotent, a conflicting re-put is
 * rejected.
 */
export class AclConflict extends Error {
  readonly id: AclNodeId;

  constructor(id: AclNodeId, message?: string) {
    super(
      message ??
        `AclConflict: ACL node ${id} already exists with different immutable data`,
    );
    this.name = "AclConflict";
    this.id = id;
  }
}

/**
 * Mutable manifest-ref attachment keyed by `SnapshotId`. Per plan §2 decision
 * 10, these refs are NOT part of the immutable `SnapshotEnvelope`; they are the
 * sole upsert surface in the store and are not content-addressed. Both fields
 * are opaque content `Hash`es (C4/C6 populate them) or `null`.
 */
export interface ManifestRefs {
  publicManifestRef: Hash | null;
  privateManifestRef: Hash | null;
}

/**
 * Pluggable persistence seam over the C1 object model. Implementations (C2
 * `MemoryStore`, future C8 `FsStore`) persist and retrieve the C1 contracts by
 * their existing ids without re-deriving them.
 */
export interface Store {
  // --- Content graph (crypto-agnostic; blobs and secret blobs share one seam) ---

  /**
   * Persist a `ContentObject` envelope. Idempotent for an identical object
   * (same `id` + `kind` + `bytes`); throws `ObjectConflict` if the same `id`
   * already exists with different immutable data. The content graph is
   * append-only: a conflicting re-put is rejected, never a silent overwrite.
   */
  putObject(obj: ContentObject): void;
  /** Retrieve a `ContentObject` by its content `Hash`, or throw `NotFound`. */
  getObject(id: Hash): ContentObject;
  /** True iff a `ContentObject` with `id` is present. */
  hasObject(id: Hash): boolean;

  // --- ACL metadata graph (signed nodes, separate from content addressing) ---

  /**
   * Persist a signed ACL node. Idempotent for an identical node (same `id` +
   * `subject` + `object` + `permissions` + `signature`); throws `AclConflict`
   * if the same `id` already exists with different immutable data. The ACL
   * metadata graph is append-only: a conflicting re-put is rejected, never a
   * silent overwrite.
   */
  putAcl(node: SignedAclNode): void;
  /** Retrieve a signed ACL node by its `AclNodeId`, or throw `NotFound`. */
  getAcl(id: AclNodeId): SignedAclNode;

  // --- Immutable snapshot envelopes (append-only / idempotent / conflict-detected) ---

  /**
   * Persist an immutable `SnapshotEnvelope`. Idempotent if an envelope with the
   * same `SnapshotId` and identical `parentId` + `serializedBytes` is already
   * stored; throws `SnapshotConflict` if the same `SnapshotId` exists with
   * different immutable core bytes.
   */
  putSnapshot(env: SnapshotEnvelope): void;
  /** Retrieve a `SnapshotEnvelope` by its `SnapshotId`, or throw `NotFound`. */
  getSnapshot(id: SnapshotId): SnapshotEnvelope;
  /** All stored `SnapshotId`s, in insertion order. */
  listSnapshots(): SnapshotId[];

  // --- Mutable manifest-ref attachment (sole upsert surface; no delete) ---

  /**
   * Upsert the `ManifestRefs` attachment for `snapshotId`. Repeating the same
   * refs is idempotent; changed refs overwrite the previous attachment. Does
   * NOT touch the immutable `SnapshotEnvelope` for `snapshotId`.
   */
  putManifestRefs(snapshotId: SnapshotId, refs: ManifestRefs): void;
  /**
   * Get the `ManifestRefs` attachment for `snapshotId`, or `{publicManifestRef:
   * null, privateManifestRef: null}` if none has been stored.
   */
  getManifestRefs(snapshotId: SnapshotId): ManifestRefs;
}
