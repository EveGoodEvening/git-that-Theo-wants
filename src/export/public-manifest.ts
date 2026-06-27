// C6 public manifest and public export bundle.
//
// This module owns the concrete `PublicManifest` schema, the public-projection
// id derivation (with nearest-public-visible-ancestor elision), the
// deterministic self-hash (`publicManifestHash`, computed with the field itself
// omitted/null), the public export bundle, and the population of C4 snapshot
// manifest refs from C6-owned code.
//
// Privacy invariants (plan §2 decision 8, C6 checklist):
//   - The public manifest/bundle carries ONLY `PublicProjectionId`s, public
//     entries (`{path, blobId}`), and `publicManifestHash`. It carries NO full
//     `SnapshotId` values, NO private paths, NO timestamps, NO messages, NO
//     op-log entries, NO manifest refs, NO sizes, NO secret ids.
//   - `PublicProjectionId = hash(bundleVersion || canonical(publicEntries) ||
//     canonical(parentProjectionIds))` where parent projection ids are the
//     **nearest public-visible ancestor** projection ids. Private-only and
//     public-noop snapshots are elided from the parent chain; a snapshot whose
//     public entries and public-visible parents are unchanged from its nearest
//     public-visible ancestor **reuses** that ancestor's `PublicProjectionId`.
//   - Two snapshots with identical public entries but different private-only
//     history produce identical projection ids, identical public manifests, and
//     identical bundle hashes.
//
// Manifest-ref population (plan C6 checklist item 5): after building a manifest,
// compute its content hash, call C4's exported `Snapshot.withManifestRefs` to
// produce a same-id snapshot value, then upsert the refs via
// `Store.putManifestRefs` — all from this C6-owned module. C4-owned files are
// never edited.

import {
  type Hash,
  type SnapshotId,
  asHash,
  concat,
  sha256,
} from "../core/ids.ts";
import type { Snapshot } from "../snapshot/snapshot.ts";
import { withManifestRefs, canonicalTreeEntries } from "../snapshot/snapshot.ts";
import { contentObjectId } from "../core/object.ts";
import type { Store, ManifestRefs } from "../store/store.ts";
import {
  type PrivateManifest,
  type PublicProjectionId,
  asPublicProjectionId,
  privateManifestHash,
} from "../policy/private-manifest.ts";
import { type VisibilityState, Denied } from "../policy/visibility.ts";

/** Public manifest bundle schema version. */
export const PUBLIC_MANIFEST_BUNDLE_VERSION = 1 as const;

/**
 * A single public entry: a public-visible path and its content blob id. Only
 * `public`-visibility files appear. The blob id is a content `Hash` (already
 * public by content addressing); no secret ids, no sizes, no timestamps.
 */
export interface PublicEntry {
  readonly path: string;
  readonly blobId: Hash;
}

/**
 * The concrete public manifest schema (plan C6 checklist item 4):
 *   `{ bundleVersion, publicProjectionIds, publicEntries, publicManifestHash }`.
 *
 * `publicManifestHash` is a **deterministic self-hash**: computed over the
 * canonical manifest payload with the `publicManifestHash` field itself
 * **omitted** (set to a fixed zero placeholder before hashing, then written
 * into the field afterward). This makes it reproducible by a verifier that
 * does not trust the stored value.
 */
export interface PublicManifest {
  readonly bundleVersion: typeof PUBLIC_MANIFEST_BUNDLE_VERSION;
  /** Projection ids of the public-visible snapshots represented by this
   *  manifest, in canonical (sorted) order. */
  readonly publicProjectionIds: readonly PublicProjectionId[];
  /** All public entries across the represented snapshots, deduped and sorted by
   *  path. */
  readonly publicEntries: readonly PublicEntry[];
  /** Deterministic self-hash of the manifest payload (field omitted when
   *  hashing). */
  readonly publicManifestHash: Hash;
}

/** Magic byte prefix for the public manifest framing. */
const PUBLIC_MANIFEST_MAGIC = 0x07;
/** Serialized layout version for the public manifest. */
const PUBLIC_MANIFEST_VERSION = 1;

/**
 * Canonical sorted public entries by path. Deterministic ordering is required
 * for the projection id and manifest hash to be reproducible.
 */
export function canonicalPublicEntries(
  entries: readonly PublicEntry[],
): readonly PublicEntry[] {
  return [...entries].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

/**
 * Canonical sorted projection ids (hex string order).
 */
export function canonicalProjectionIds(
  ids: readonly PublicProjectionId[],
): readonly PublicProjectionId[] {
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Framed bytes for a list of public entries: a leading count, then for each
 * entry (sorted by path) `<path-byte-len>\0<path>\0<blobId-hex(64)>`. The count
 * prefix makes the entries block self-delimiting in the manifest payload (the
 * trailing `publicManifestHash` is appended after, with no terminator needed).
 */
function framePublicEntries(entries: readonly PublicEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const sorted = canonicalPublicEntries(entries);
  const chunks: Uint8Array[] = [enc.encode(`${sorted.length}\0`)];
  for (const e of sorted) {
    const pathBytes = enc.encode(e.path);
    chunks.push(enc.encode(`${pathBytes.length}\0`));
    chunks.push(pathBytes);
    chunks.push(enc.encode(`\0${e.blobId}`));
  }
  return concat(chunks);
}

/**
 * Framed bytes for a list of projection ids: each id is `<hex(64)>` joined by
 * `\0`, with a leading count.
 */
function frameProjectionIds(ids: readonly PublicProjectionId[]): Uint8Array {
  const enc = new TextEncoder();
  const sorted = canonicalProjectionIds(ids);
  const chunks: Uint8Array[] = [enc.encode(`${sorted.length}\0`)];
  for (const id of sorted) {
    chunks.push(enc.encode(`${id}\0`));
  }
  return concat(chunks);
}

/**
 * Compute a `PublicProjectionId` for a public-visible snapshot:
 *   `hash(bundleVersion || canonical(publicEntries) || canonical(parentProjectionIds))`
 * where `parentProjectionIds` are the **nearest public-visible ancestor**
 * projection ids (already elided of private-only and public-noop snapshots by
 * the caller). The id is derived ONLY from public data — no `SnapshotId`, no
 * timestamps, no messages.
 */
export async function computePublicProjectionId(
  publicEntries: readonly PublicEntry[],
  parentProjectionIds: readonly PublicProjectionId[],
): Promise<PublicProjectionId> {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [
    enc.encode(`pubproj\0${PUBLIC_MANIFEST_BUNDLE_VERSION}\0`),
    framePublicEntries(publicEntries),
    frameProjectionIds(parentProjectionIds),
  ];
  const h = await sha256(concat(chunks));
  return asPublicProjectionId(h);
}

/**
 * Canonical framed bytes for the public manifest payload **with the
 * `publicManifestHash` field omitted**. This is the input to the deterministic
 * self-hash. Omitting the self-hash field is equivalent to field-bearing
 * encodings that hash with a fixed `null`/zero placeholder: a verifier ignores
 * the stored self-hash and recomputes this payload from the remaining fields.
 *
 * Layout:
 *   magic(1) || version(1) || bundleVersion(decimal)\0
 *   projectionIds block (count + ids)
 *   publicEntries block (path/blobId pairs, sorted)
 */
export function canonicalPublicManifestPayload(
  manifest: Omit<PublicManifest, "publicManifestHash">,
): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [
    new Uint8Array([PUBLIC_MANIFEST_MAGIC, PUBLIC_MANIFEST_VERSION]),
    enc.encode(`${manifest.bundleVersion}\0`),
    frameProjectionIds(manifest.publicProjectionIds),
    framePublicEntries(manifest.publicEntries),
  ];
  return concat(chunks);
}


/**
 * Compute the deterministic self-hash of a public manifest payload: the hash is
 * over the canonical payload with the `publicManifestHash` field omitted. A
 * verifier recomputes this over the payload (ignoring the stored
 * `publicManifestHash`) and compares.
 */
export async function computePublicManifestHash(
  payload: Omit<PublicManifest, "publicManifestHash">,
): Promise<Hash> {
  return sha256(canonicalPublicManifestPayload(payload));
}

/**
 * Build a `PublicManifest` from its components, computing the deterministic
 * `publicManifestHash` (field omitted while hashing).
 */
export async function buildPublicManifest(
  publicProjectionIds: readonly PublicProjectionId[],
  publicEntries: readonly PublicEntry[],
): Promise<PublicManifest> {
  const payload = {
    bundleVersion: PUBLIC_MANIFEST_BUNDLE_VERSION,
    publicProjectionIds: canonicalProjectionIds(publicProjectionIds),
    publicEntries: canonicalPublicEntries(publicEntries),
  };
  const publicManifestHash = await computePublicManifestHash(payload);
  return { ...payload, publicManifestHash };
}

/**
 * Verify a `PublicManifest`'s `publicManifestHash` by recomputing it over the
 * payload (field omitted). Returns `true` iff the recomputed hash equals the
 * stored `publicManifestHash`.
 */
export async function verifyPublicManifest(manifest: PublicManifest): Promise<boolean> {
  const payload = {
    bundleVersion: manifest.bundleVersion,
    publicProjectionIds: manifest.publicProjectionIds,
    publicEntries: manifest.publicEntries,
  };
  const recomputed = await computePublicManifestHash(payload);
  return recomputed === manifest.publicManifestHash;
}

/**
 * Serialize a `PublicManifest` to self-describing bytes, including the
 * `publicManifestHash` field. Layout extends the payload framing with the hash.
 */
export function serializePublicManifest(manifest: PublicManifest): Uint8Array {
  const enc = new TextEncoder();
  const payload = canonicalPublicManifestPayload(manifest);
  return concat([
    payload,
    enc.encode(`${manifest.publicManifestHash}`),
  ]);
}

/**
 * Parse a `PublicManifest` from `serializePublicManifest` output and verify the
 * self-hash. Async because hashing is async. Throws on malformed framing or a
 * hash mismatch.
 */
export async function parsePublicManifest(data: Uint8Array): Promise<PublicManifest> {
  if (data[0] !== PUBLIC_MANIFEST_MAGIC) {
    throw new Error("public manifest: bad magic");
  }
  if (data[1] !== PUBLIC_MANIFEST_VERSION) {
    throw new Error(`public manifest: unsupported version ${data[1]}`);
  }
  let off = 2;
  const { str: bvStr, end: bvEnd } = readUntil(data, off);
  off = bvEnd;
  const bundleVersion = parseCount(bvStr, "bundleVersion");
  if (bundleVersion !== PUBLIC_MANIFEST_BUNDLE_VERSION) {
    throw new Error(`public manifest: bad bundleVersion ${bundleVersion}`);
  }
  const { str: projCountStr, end: pcEnd } = readUntil(data, off);
  off = pcEnd;
  const projCount = parseCount(projCountStr, "projectionCount");
  const publicProjectionIds: PublicProjectionId[] = [];
  for (let i = 0; i < projCount; i++) {
    const { str, end } = readUntil(data, off);
    off = end;
    publicProjectionIds.push(asPublicProjectionId(str));
  }
  // Entries: a leading count, then path-len\0path\0blobId(64) per entry.
  const { str: entryCountStr, end: ecEnd } = readUntil(data, off);
  off = ecEnd;
  const entryCount = parseCount(entryCountStr, "entryCount");
  const publicEntries: PublicEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    const { str: lenStr, end: lenEnd } = readUntil(data, off);
    off = lenEnd;
    const pathLen = parseCount(lenStr, "pathLen");
    if (off + pathLen > data.length) {
      throw new Error("public manifest: truncated path");
    }
    const path = new TextDecoder().decode(data.subarray(off, off + pathLen));
    off += pathLen;
    if (data[off] !== 0x00) {
      throw new Error("public manifest: missing path terminator");
    }
    off++;
    if (off + 64 > data.length) {
      throw new Error("public manifest: truncated blobId");
    }
    const blobId = asHash(
      new TextDecoder().decode(data.subarray(off, off + 64)),
    );
    off += 64;
    publicEntries.push({ path, blobId });
  }
  const HASH_HEX_LEN = 64;
  if (off + HASH_HEX_LEN !== data.length) {
    throw new Error("public manifest: trailing data after hash");
  }
  const publicManifestHash = asHash(
    new TextDecoder().decode(data.subarray(off, off + HASH_HEX_LEN)),
  );
  const manifest: PublicManifest = {
    bundleVersion: PUBLIC_MANIFEST_BUNDLE_VERSION,
    publicProjectionIds: canonicalProjectionIds(publicProjectionIds),
    publicEntries: canonicalPublicEntries(publicEntries),
    publicManifestHash,
  };
  if (!(await verifyPublicManifest(manifest))) {
    throw new Error("public manifest: hash mismatch");
  }
  return manifest;
}

/** Read a NUL-terminated ASCII field from `data` starting at `offset`. */
function readUntil(
  data: Uint8Array,
  offset: number,
): { str: string; end: number } {
  let end = offset;
  while (end < data.length && data[end] !== 0x00) end++;
  if (end >= data.length) {
    throw new Error("public manifest: truncated field");
  }
  const str = new TextDecoder().decode(data.subarray(offset, end));
  return { str, end: end + 1 };
}

/** Parse a canonical non-negative decimal count field. */
function parseCount(s: string, field: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(s)) {
    throw new Error(`public manifest: bad ${field}: ${s}`);
  }
  return Number(s);
}

// ---------------------------------------------------------------------------
// Public projection derivation: nearest public-visible ancestor elision.
// ---------------------------------------------------------------------------

/**
 * Per-snapshot visibility info supplied by the caller: the snapshot's own
 * visibility state plus a per-path visibility map (for file-level filtering).
 * A snapshot is "public-visible" if its `state` is `public`; its public entries
 * are the paths whose per-path state is `public` (falling back to the snapshot
 * state when a path is not individually mapped).
 */
export interface SnapshotVisibility {
  readonly state: VisibilityState;
  /** Per-path visibility overrides; absent path falls back to `state`. */
  readonly pathStates?: ReadonlyMap<string, VisibilityState>;
}

/**
 * The public entries of a snapshot: paths whose effective visibility is
 * `public`, as `{path, blobId}`. Returns `[]` for private/embargoed snapshots
 * or snapshots with no public paths (those states are *omitted* from export per
 * the visibility matrix).
 *
 * `local-only` is **rejected**, not omitted: a `local-only` snapshot, or a
 * `local-only` file within an otherwise-public snapshot, throws a typed
 * `Denied` error. Per plan §2 / the visibility matrix, `local-only + export ->
 * deny` — local-only content must never leave the owner's process, and an
 * export path must not silently strip it into an omittable no-op. Private and
 * embargoed content may be silently omitted (they are exportable states that
 * simply carry no public entries); local-only may not.
 */
export function publicEntriesOf(
  snapshot: Snapshot,
  vis: SnapshotVisibility,
): PublicEntry[] {
  if (vis.state === "local-only") {
    throw new Denied(
      "local-only",
      "export",
      "owner",
      "publicEntriesOf: local-only snapshots cannot be exported",
    );
  }
  if (vis.state !== "public") return [];
  const out: PublicEntry[] = [];
  for (const [path, blobId] of canonicalTreeEntries(snapshot.tree)) {
    const eff = vis.pathStates?.get(path) ?? vis.state;
    if (eff === "local-only") {
      // Generic message: the private path must not leak via the error text.
      // Programmatic detail is available via the typed (state, op, role) fields.
      throw new Denied(
        "local-only",
        "export",
        "owner",
        "publicEntriesOf: local-only files cannot be exported",
      );
    }
    if (eff === "public") {
      out.push({ path, blobId });
    }
  }
  return out;
}

/**
 * Whether a snapshot is "public-noop" relative to its nearest public-visible
 * ancestor: its public entries are unchanged from the ancestor's. Per plan §2
 * decision 8, such a snapshot reuses the ancestor's `PublicProjectionId`
 * instead of minting a new one. (The parent-link equality is implied: the
 * ancestor IS the nearest public-visible ancestor, so the public-visible
 * parent relationship is unchanged.)
 */
export function isPublicNoop(
  publicEntries: readonly PublicEntry[],
  ancestorEntries: readonly PublicEntry[],
): boolean {
  return entriesEqual(publicEntries, ancestorEntries);
}

function entriesEqual(
  a: readonly PublicEntry[],
  b: readonly PublicEntry[],
): boolean {
  if (a.length !== b.length) return false;
  const ca = canonicalPublicEntries(a);
  const cb = canonicalPublicEntries(b);
  for (let i = 0; i < ca.length; i++) {
    if (ca[i].path !== cb[i].path || ca[i].blobId !== cb[i].blobId) return false;
  }
  return true;
}


/**
 * A node in the public projection graph: the projection id for a public-visible
 * snapshot, its public entries, and its nearest public-visible ancestor
 * projection ids.
 */
export interface PublicProjectionNode {
  readonly projectionId: PublicProjectionId;
  readonly publicEntries: readonly PublicEntry[];
  readonly parentProjectionIds: readonly PublicProjectionId[];
}

/**
 * Derive the public projection graph for a chain of snapshots (oldest first),
 * applying nearest-public-visible-ancestor elision.
 *
 * For each snapshot in order:
 *   - If it is `local-only`, throw a typed `Denied` error. `local-only` content
 *     must never leave the owner's process; an export path must not silently
 *     strip it. A `local-only` file within an otherwise-public snapshot is
 *     likewise rejected by `publicEntriesOf`.
 *   - If it is private/embargoed (non-public, non-local-only), skip it (elided
 *     from the public projection graph; contributes no node and no entries).
 *   - If it is public-visible, compute its public entries and its nearest
 *     public-visible ancestor projection ids (the projection ids of the most
 *     recent public-visible snapshots in the chain before it, by parent link).
 *   - If its public entries are unchanged from its nearest public-visible
 *     ancestor, it **reuses** that ancestor's `PublicProjectionId`
 *     (public-noop), inheriting the ancestor's public-parent context unchanged.
 *
 * Returns the projection nodes (one per public-visible snapshot, in chain
 * order) and a map from `SnapshotId` to its `PublicProjectionId` (for the
 * private manifest).
 */
export async function derivePublicProjection(
  chain: readonly Snapshot[],
  visibility: ReadonlyMap<SnapshotId, SnapshotVisibility>,
): Promise<{
  nodes: readonly PublicProjectionNode[];
  projectionBySnapshot: ReadonlyMap<SnapshotId, PublicProjectionId>;
}> {
  const nodes: PublicProjectionNode[] = [];
  const projectionBySnapshot = new Map<SnapshotId, PublicProjectionId>();
  // Track the nearest public-visible, non-noop projection node for every
  // processed snapshot id. Non-public and public-noop snapshots inherit their
  // parent's nearest node, so private-only history cannot appear in public
  // parent links.
  const nearestBySnapshot = new Map<SnapshotId, PublicProjectionNode>();

  for (const snap of chain) {
    const nearestAncestor = snap.parentId === null
      ? null
      : nearestBySnapshot.get(snap.parentId) ?? null;
    const vis = visibility.get(snap.id);
    if (vis === undefined) {
      // No visibility info: treat as non-public and elide (inherit ancestor).
      if (nearestAncestor !== null) {
        nearestBySnapshot.set(snap.id, nearestAncestor);
      }
      continue;
    }
    if (vis.state === "local-only") {
      // local-only is rejected, not elided: it must never be silently stripped
      // into an exportable projection. Private/embargoed are elided (omitted
      // from export); local-only is an explicit denial.
      throw new Denied(
        "local-only",
        "export",
        "owner",
        "derivePublicProjection: local-only snapshots cannot be exported",
      );
    }
    if (vis.state !== "public") {
      // private/embargoed: elided from the public projection graph. They still
      // inherit the nearest public-visible ancestor for public descendants.
      if (nearestAncestor !== null) {
        nearestBySnapshot.set(snap.id, nearestAncestor);
      }
      continue;
    }

    const entries = publicEntriesOf(snap, vis);

    // Public-noop: reuse the nearest public-visible ancestor's projection id.
    if (
      nearestAncestor !== null &&
      isPublicNoop(entries, nearestAncestor.publicEntries)
    ) {
      projectionBySnapshot.set(snap.id, nearestAncestor.projectionId);
      nearestBySnapshot.set(snap.id, nearestAncestor);
      continue;
    }

    const parentProjectionIds = nearestAncestor
      ? [nearestAncestor.projectionId]
      : [];
    const projectionId = await computePublicProjectionId(
      entries,
      parentProjectionIds,
    );
    const node: PublicProjectionNode = {
      projectionId,
      publicEntries: entries,
      parentProjectionIds,
    };
    nodes.push(node);
    projectionBySnapshot.set(snap.id, projectionId);
    nearestBySnapshot.set(snap.id, node);
  }

  return { nodes, projectionBySnapshot };
}

// ---------------------------------------------------------------------------
// Public export bundle.
// ---------------------------------------------------------------------------

/**
 * The public export bundle: the public manifest plus the public content objects
 * (the blobs referenced by `publicEntries`). Carries ONLY public data — no full
 * `SnapshotId`s, no private metadata. The bundle's integrity hash is the
 * `publicManifestHash` (deterministic over the manifest payload).
 */
export interface PublicExportBundle {
  readonly manifest: PublicManifest;
  /** Public content objects keyed by their content `Hash`. */
  readonly objects: ReadonlyMap<Hash, { readonly kind: "blob"; readonly bytes: Uint8Array }>;
}

/**
 * Build a public export bundle from a public projection graph and a store.
 * Fetches only the blobs referenced by public entries; never fetches secret
 * blobs, private paths, or any object not in the public entries. Throws
 * `NotFound` (from the store) if a public blob is missing.
 *
 * The manifest's `publicEntries` reflect the **latest** public projection
 * state, not an accumulation of every public snapshot's entries: if a later
 * public snapshot removes a path (or the path becomes non-public/omitted), the
 * older blob/path must not remain in the final manifest or bundle. Stale
 * accumulation would leak paths the current public state no longer exposes.
 * `publicProjectionIds` still lists every represented public-visible snapshot.
 */
export async function buildPublicExportBundle(
  nodes: readonly PublicProjectionNode[],
  store: Store,
): Promise<PublicExportBundle> {
  // The current public state is the last public-visible node in chain order
  // (nodes are oldest-first). A path absent from the latest node's entries is
  // no longer public and must not be carried forward from older nodes.
  const latestEntries = nodes.length === 0
    ? []
    : nodes[nodes.length - 1].publicEntries;
  const publicEntries = canonicalPublicEntries(latestEntries);
  const publicProjectionIds = canonicalProjectionIds(
    nodes.map((n) => n.projectionId),
  );
  const manifest = await buildPublicManifest(publicProjectionIds, publicEntries);

  const objects = new Map<Hash, { readonly kind: "blob"; readonly bytes: Uint8Array }>();
  for (const e of publicEntries) {
    const obj = store.getObject(e.blobId);
    if (obj.kind !== "blob") {
      // A secret-blob must never appear in public entries; this is a hard
      // integrity failure, not a privacy omission.
      throw new Error(
        `public export: object ${e.blobId} for path ${e.path} is not a blob`,
      );
    }
    objects.set(e.blobId, { kind: "blob", bytes: new Uint8Array(obj.bytes) });
  }

  return { manifest, objects };
}

/**
 * Verify a public export bundle's integrity: recompute the manifest self-hash,
 * verify every referenced blob is present and that its content hash matches the
 * referenced blob id, and reject any **extra** object whose id is not
 * referenced by `manifest.publicEntries` (e.g. a smuggled private bytes blob).
 * Returns `true` iff the bundle is intact and carries exactly the referenced
 * objects.
 */
export async function verifyPublicExportBundle(
  bundle: PublicExportBundle,
): Promise<boolean> {
  if (!(await verifyPublicManifest(bundle.manifest))) return false;
  // The set of object ids the manifest actually references.
  const referenced = new Set<Hash>();
  for (const e of bundle.manifest.publicEntries) {
    referenced.add(e.blobId);
    const obj = bundle.objects.get(e.blobId);
    if (obj === undefined) return false;
    // Recompute the ContentObject envelope content hash for the blob bytes
    // and compare to the referenced blob id (the tree stores envelope ids).
    const h = await contentObjectId("blob", obj.bytes);
    if (h !== e.blobId) return false;
  }
  // Exactness: no object may be present that the manifest does not reference.
  // This rejects bundles that smuggle extra (e.g. private) bytes alongside the
  // valid public objects.
  if (bundle.objects.size !== referenced.size) return false;
  for (const id of bundle.objects.keys()) {
    if (!referenced.has(id)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Manifest-ref population (C6-owned code populates C4 snapshot refs).
// ---------------------------------------------------------------------------

/**
 * After building the public and private manifests for a snapshot, populate the
 * C4 snapshot's manifest refs **from C6-owned code**: call
 * `Snapshot.withManifestRefs(publicHash, privateHash)` to produce a same-id
 * snapshot value, then upsert the refs via `Store.putManifestRefs` keyed by
 * `SnapshotId`. The immutable `SnapshotEnvelope` is never replaced.
 *
 * Returns the updated `Snapshot` (same `id`, new manifest refs) for the caller
 * to optionally re-persist the envelope (idempotent) — but the envelope bytes
 * are unchanged, so re-persistence is a no-op.
 */
export function attachManifestRefs(
  snapshot: Snapshot,
  store: Store,
  publicManifestRef: Hash | null,
  privateManifestRef: Hash | null,
): { snapshot: Snapshot; refs: ManifestRefs } {
  const updated = withManifestRefs(
    snapshot,
    publicManifestRef,
    privateManifestRef,
  );
  const refs: ManifestRefs = { publicManifestRef, privateManifestRef };
  store.putManifestRefs(snapshot.id, refs);
  return { snapshot: updated, refs };
}

/**
 * Build the public manifest, the private manifest, and attach their content
 * hashes to a snapshot's manifest refs, for a single public-visible snapshot.
 *
 * This is the canonical C6 entrypoint that ties together:
 *   1. public projection id derivation (this module),
 *   2. private manifest construction (`private-manifest.ts`),
 *   3. manifest-ref attachment via `Snapshot.withManifestRefs` +
 *      `Store.putManifestRefs` (this module).
 *
 * Rejects `local-only` snapshots with a typed `Denied` error: a `local-only`
 * snapshot must never produce a public manifest or public refs (plan §2:
 * `local-only` content never leaves the owner's process). Building empty public
 * refs for it would silently strip local-only content into an exportable
 * attachment, violating the export invariant.
 *
 * For multi-snapshot chains, use `derivePublicProjection` +
 * `buildPublicExportBundle` + `attachManifestRefs` directly.
 */
export async function buildAndAttachManifests(
  snapshot: Snapshot,
  visibility: SnapshotVisibility,
  store: Store,
  parentProjectionIds: readonly PublicProjectionId[] = [],
): Promise<{
  projectionId: PublicProjectionId;
  publicManifest: PublicManifest;
  publicManifestRef: Hash;
  privateManifestRef: Hash | null;
  updatedSnapshot: Snapshot;
}> {
  if (visibility.state === "local-only") {
    throw new Denied(
      "local-only",
      "export",
      "owner",
      "buildAndAttachManifests: local-only snapshots cannot be exported",
    );
  }
  const entries = publicEntriesOf(snapshot, visibility);
  const projectionId = await computePublicProjectionId(entries, parentProjectionIds);
  const publicManifest = await buildPublicManifest([projectionId], entries);
  const publicManifestRef = publicManifest.publicManifestHash;
  // The private manifest for a single snapshot records its SnapshotId ->
  // projectionId mapping. Its content hash populates privateManifestRef.
  const privManifest: PrivateManifest = {
    entries: [
      {
        snapshotId: snapshot.id,
        projectionId,
        parentProjectionIds: [...parentProjectionIds],
      },
    ],
  };
  const privHash = await privateManifestHash(privManifest);
  const { snapshot: updatedSnapshot } = attachManifestRefs(
    snapshot,
    store,
    publicManifestRef,
    privHash,
  );
  return {
    projectionId,
    publicManifest,
    publicManifestRef,
    privateManifestRef: privHash,
    updatedSnapshot,
  };
}
