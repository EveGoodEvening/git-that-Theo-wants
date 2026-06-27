// C6 private manifest: the private-side mapping from full `SnapshotId` to
// `PublicProjectionId`.
//
// Per plan §2 decision 10, the private manifest maps `SnapshotId ->
// PublicProjectionId` (so it contains full `SnapshotId` values, which embed
// timestamps, messages, private paths, and private blob ids). It is therefore
// **private**: it never appears in a public export bundle. Its content hash is
// upserted into a snapshot's `privateManifestRef` attachment via
// `Store.putManifestRefs` (the C2 mutable attachment, NOT the immutable
// `SnapshotEnvelope`).
//
// The private manifest is the bridge that lets the owner correlate a public
// projection back to its private snapshot, while a public peer only ever sees
// `PublicProjectionId`s. It is the sole place `SnapshotId` values are mapped to
// projection ids; the public manifest carries only projection ids and public
// entries.

import {
  type Hash,
  type SnapshotId,
  asSnapshotId,
  concat,
  sha256,
} from "../core/ids.ts";

/**
 * Brand for a public-projection id: a canonical id derived ONLY from public
 * entries and public metadata (nearest public-visible ancestor projection ids).
 * It is NOT a `SnapshotId` — it embeds no timestamps, messages, private paths,
 * or private blob ids. It is a separate branded alias so the two cannot be
 * accidentally mixed at the type level.
 */
export type PublicProjectionId = string & {
  readonly __brand: "PublicProjectionId";
};

/** Brand a valid 64-char hex string as a `PublicProjectionId`. */
export function asPublicProjectionId(hex: string): PublicProjectionId {
  if (
    typeof hex !== "string" ||
    hex.length !== 64 ||
    !/^[0-9a-f]+$/.test(hex)
  ) {
    throw new Error(`invalid PublicProjectionId: ${hex}`);
  }
  return hex as PublicProjectionId;
}

/**
 * A single entry in the private manifest: the full `SnapshotId` and its
 * derived `PublicProjectionId`, plus the projection ids of the nearest
 * public-visible ancestors (the parent links in the public projection graph).
 */
export interface PrivateManifestEntry {
  readonly snapshotId: SnapshotId;
  readonly projectionId: PublicProjectionId;
  /** Nearest public-visible ancestor projection ids (deterministic, ordered). */
  readonly parentProjectionIds: readonly PublicProjectionId[];
}

/**
 * The private manifest: the authoritative `SnapshotId -> PublicProjectionId`
 * mapping plus the public-projection parent links. Private-only. Its content
 * hash populates `privateManifestRef`.
 */
export interface PrivateManifest {
  readonly entries: readonly PrivateManifestEntry[];
}

/** Magic byte prefix for the private manifest framing. */
const PRIVATE_MANIFEST_MAGIC = 0x06;
/** Serialized layout version for the private manifest. */
const PRIVATE_MANIFEST_VERSION = 1;

/**
 * Canonical framed bytes for a `PrivateManifest`. Layout:
 *   magic(1) || version(1) || entryCount(decimal)\0
 *   per entry:
 *     snapshotId-hex(64)\0 projectionId-hex(64)\0 parentCount(decimal)\0
 *     per parent: projectionId-hex(64)\0
 *
 * Entries are sorted by `snapshotId` (hex string order) for determinism.
 */
export function canonicalPrivateManifest(manifest: PrivateManifest): Uint8Array {
  const enc = new TextEncoder();
  const sorted = [...manifest.entries].sort((a, b) =>
    a.snapshotId < b.snapshotId ? -1 : a.snapshotId > b.snapshotId ? 1 : 0,
  );
  const chunks: Uint8Array[] = [];
  chunks.push(new Uint8Array([PRIVATE_MANIFEST_MAGIC, PRIVATE_MANIFEST_VERSION]));
  chunks.push(enc.encode(`${sorted.length}\0`));
  for (const e of sorted) {
    chunks.push(enc.encode(`${e.snapshotId}\0`));
    chunks.push(enc.encode(`${e.projectionId}\0`));
    const parents = [...e.parentProjectionIds].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    chunks.push(enc.encode(`${parents.length}\0`));
    for (const p of parents) {
      chunks.push(enc.encode(`${p}\0`));
    }
  }
  return concat(chunks);
}

/**
 * Compute the content `Hash` of a `PrivateManifest` over its canonical framing.
 * This is the value upserted into `privateManifestRef`.
 */
export async function privateManifestHash(
  manifest: PrivateManifest,
): Promise<Hash> {
  return sha256(canonicalPrivateManifest(manifest));
}

/**
 * Parse a `PrivateManifest` from the canonical framing (inverse of
 * `canonicalPrivateManifest`). Strict: rejects malformed framing.
 */
export function parsePrivateManifest(data: Uint8Array): PrivateManifest {
  let off = 0;
  if (data[off] !== PRIVATE_MANIFEST_MAGIC) {
    throw new Error("private manifest: bad magic");
  }
  off++;
  if (data[off] !== PRIVATE_MANIFEST_VERSION) {
    throw new Error(`private manifest: unsupported version ${data[off]}`);
  }
  off++;
  const { str: countStr, end: cEnd } = readUntil(data, off);
  const count = parseCount(countStr, "entryCount");
  off = cEnd;
  const entries: PrivateManifestEntry[] = [];
  for (let i = 0; i < count; i++) {
    const { str: snapStr, end: sEnd } = readUntil(data, off);
    off = sEnd;
    const { str: projStr, end: pEnd } = readUntil(data, off);
    off = pEnd;
    const { str: parCountStr, end: pcEnd } = readUntil(data, off);
    const parCount = parseCount(parCountStr, "parentCount");
    off = pcEnd;
    const parents: PublicProjectionId[] = [];
    for (let j = 0; j < parCount; j++) {
      const { str: parStr, end: parEnd } = readUntil(data, off);
      off = parEnd;
      parents.push(asPublicProjectionId(parStr));
    }
    entries.push({
      snapshotId: asSnapshotId(snapStr),
      projectionId: asPublicProjectionId(projStr),
      parentProjectionIds: parents,
    });
  }
  if (off !== data.length) {
    throw new Error("private manifest: trailing data");
  }
  return { entries };
}

/** Read a NUL-terminated ASCII field from `data` starting at `offset`. */
function readUntil(
  data: Uint8Array,
  offset: number,
): { str: string; end: number } {
  let end = offset;
  while (end < data.length && data[end] !== 0x00) end++;
  if (end >= data.length) {
    throw new Error("private manifest: truncated field");
  }
  const str = new TextDecoder().decode(data.subarray(offset, end));
  return { str, end: end + 1 };
}

/** Parse a canonical non-negative decimal count field. */
function parseCount(s: string, field: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(s)) {
    throw new Error(`private manifest: bad ${field}: ${s}`);
  }
  return Number(s);
}

/**
 * Look up the `PublicProjectionId` for a `SnapshotId` in a private manifest.
 * Returns `undefined` if the snapshot is not recorded.
 */
export function projectionForSnapshot(
  manifest: PrivateManifest,
  snapshotId: SnapshotId,
): PublicProjectionId | undefined {
  for (const e of manifest.entries) {
    if (e.snapshotId === snapshotId) return e.projectionId;
  }
  return undefined;
}

