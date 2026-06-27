// C1 snapshot storage contract: the minimal `SnapshotEnvelope` storage shape.
//
// This is **storage shape only**, not the full `Snapshot` record. C4 defines
// the full `Snapshot` (parent id, timestamp, message, immutable flag, manifest
// refs) and computes the `SnapshotId` from the snapshot's core state per plan
// §2 decision 10. C1 only defines the opaque envelope that the store (C2)
// persists: `{ id, parentId, serializedBytes }`.
//
// `serializedBytes` stores only immutable core snapshot state (C4 fills it in);
// manifest refs are *not* embedded here — they live in a separate mutable
// `ManifestRefs` attachment (C2/C4). `SnapshotId` is treated opaquely by C1:
// it is a branded SHA-256 hex string, but C1 does not compute it.

import {
  type SnapshotId,
  asSnapshotId,
  concat,
  isHash,
  parseDecimalLen,
} from "./ids.ts";

/** Magic byte prefix for the serialized `SnapshotEnvelope`. */
const SNAPSHOT_MAGIC = 0x03;
/** Serialized layout version for `SnapshotEnvelope`. */
const SNAPSHOT_VERSION = 1;

/**
 * Minimal immutable storage envelope for a snapshot. The store (C2) persists
 * and retrieves these. `id` is the opaque `SnapshotId`; `parentId` is the
 * parent snapshot's id or `null` for a root; `serializedBytes` is the opaque
 * immutable core state (C4 defines its contents).
 */
export interface SnapshotEnvelope {
  /** Opaque content-addressed snapshot identity (computed in C4). */
  readonly id: SnapshotId;
  /** Parent snapshot id, or `null` for a root snapshot. */
  readonly parentId: SnapshotId | null;
  /** Opaque immutable core snapshot state bytes (defined in C4). */
  readonly serializedBytes: Uint8Array;
}

/**
 * Canonical framed bytes for a `SnapshotEnvelope`:
 * `snap\0<magic(1)><version(1)><parentId-flag(1)><parentId-hex(0|64)><len>\0<bytes>`.
 *
 * The `parentId-flag` is `0x00` for `null` parentId (no id bytes follow) or
 * `0x01` for a present parentId (64 hex bytes follow). This makes the framing
 * self-delimiting and deterministic, so the envelope is content-addressable by
 * C4 if needed. C1 itself does not hash this framing to produce the `id`.
 */
export function snapshotEnvelopeFraming(env: SnapshotEnvelope): Uint8Array {
  const header = new TextEncoder().encode("snap");
  const flag = env.parentId === null ? 0x00 : 0x01;
  const parentBytes = env.parentId === null
    ? new Uint8Array(0)
    : new TextEncoder().encode(env.parentId);
  const lenBytes = new TextEncoder().encode(String(env.serializedBytes.length));
  return concat([
    header,
    new Uint8Array([0]),
    new Uint8Array([SNAPSHOT_MAGIC, SNAPSHOT_VERSION, flag]),
    parentBytes,
    lenBytes,
    new Uint8Array([0]),
    env.serializedBytes,
  ]);
}

/**
 * Serialize a `SnapshotEnvelope` to self-describing bytes:
 * `<framing><id-hex>\0`. The envelope id is carried for storage convenience
 * and verified on parse.
 */
export function serializeSnapshotEnvelope(env: SnapshotEnvelope): Uint8Array {
  const framed = snapshotEnvelopeFraming(env);
  const idHex = new TextEncoder().encode(env.id);
  return concat([framed, idHex, new Uint8Array([0])]);
}

/** Parse and verify a `SnapshotEnvelope` from `serializeSnapshotEnvelope` output. */
export function parseSnapshotEnvelope(data: Uint8Array): SnapshotEnvelope {
  // Trailing `<id-hex(64)>\0`.
  if (data.length === 0 || data[data.length - 1] !== 0) {
    throw new Error("Invalid SnapshotEnvelope serialization: missing trailing delimiter");
  }
  if (data.length < 64 + 1) {
    throw new Error("Invalid SnapshotEnvelope serialization: too short");
  }
  const idHex = new TextDecoder().decode(data.subarray(data.length - 1 - 64, data.length - 1));
  if (!isHash(idHex)) {
    throw new Error("Invalid SnapshotEnvelope serialization: bad id hash");
  }
  const head = data.subarray(0, data.length - 1 - 64); // framing only

  const header = new TextEncoder().encode("snap");
  if (head.length < header.length + 1 + 3) {
    throw new Error("Invalid SnapshotEnvelope serialization: too short for header");
  }
  for (let i = 0; i < header.length; i++) {
    if (head[i] !== header[i]) {
      throw new Error("Invalid SnapshotEnvelope serialization: bad header");
    }
  }
  if (head[header.length] !== 0) {
    throw new Error("Invalid SnapshotEnvelope serialization: bad header delimiter");
  }
  const off = header.length + 1;
  if (head[off] !== SNAPSHOT_MAGIC) {
    throw new Error("Invalid SnapshotEnvelope serialization: bad magic");
  }
  if (head[off + 1] !== SNAPSHOT_VERSION) {
    throw new Error(`Unsupported SnapshotEnvelope version: ${head[off + 1]}`);
  }
  const flag = head[off + 2]!;
  if (flag !== 0x00 && flag !== 0x01) {
    throw new Error(`Invalid SnapshotEnvelope serialization: bad parentId flag ${flag}`);
  }
  let i = off + 3;
  let parentId: SnapshotId | null;
  if (flag === 0x00) {
    parentId = null;
  } else {
    if (i + 64 > head.length) {
      throw new Error("Invalid SnapshotEnvelope serialization: parentId truncated");
    }
    const parentHex = new TextDecoder().decode(head.subarray(i, i + 64));
    if (!isHash(parentHex)) {
      throw new Error("Invalid SnapshotEnvelope serialization: bad parentId hash");
    }
    parentId = asSnapshotId(parentHex);
    i += 64;
  }
  // `<len>\0<bytes>`
  let nul = -1;
  for (let j = i; j < head.length; j++) {
    if (head[j] === 0) {
      nul = j;
      break;
    }
  }
  if (nul < 0) throw new Error("Invalid SnapshotEnvelope serialization: missing length delimiter");
  const lenStr = new TextDecoder().decode(head.subarray(i, nul));
  let len: number;
  try {
    len = parseDecimalLen(lenStr);
  } catch {
    throw new Error(`Invalid SnapshotEnvelope serialization: bad length "${lenStr}"`);
  }
  const bytes = head.subarray(nul + 1);
  if (bytes.length !== len) {
    throw new Error(
      `Invalid SnapshotEnvelope serialization: length mismatch (header=${len}, actual=${bytes.length})`,
    );
  }
  return { id: asSnapshotId(idHex), parentId, serializedBytes: bytes.slice() };
}

