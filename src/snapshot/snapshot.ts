// C4 snapshot working-copy model (JJ-style).
//
// The full `Snapshot` record wraps a C3 `VirtualTree` (the path→blob-id core
// tree) together with the snapshot's core metadata: parent id, timestamp,
// message, and an immutable flag. Manifest refs (`publicManifestRef` /
// `privateManifestRef`) are **opaque content hashes** carried alongside the
// core state but **excluded** from the `SnapshotId` hash and from the immutable
// `SnapshotEnvelope.serializedBytes` (plan §2 decision 10). They are persisted
// through the Store's separate mutable `ManifestRefs` attachment keyed by
// `SnapshotId`.
//
// `SnapshotId` is the content hash of the snapshot's **core state only**:
//   `parentId` || canonical tree entries (path + blob id, sorted by path) ||
//   `timestamp` || `message` || `immutable` flag.
// Tree identity is the canonical `(path, blobId)` set sorted by path, so a
// path-only rename/move changes the `SnapshotId` even when every blob id is
// unchanged. Manifest refs are not inputs to the id; `Snapshot.withManifestRefs`
// returns a snapshot with the same `SnapshotId` and leaves the core envelope
// bytes unchanged.
//
// `SnapshotEnvelope.serializedBytes` stores only the immutable core snapshot
// state (the same bytes hashed to produce the `SnapshotId`, plus the `id` is
// carried in the envelope header by C1). Manifest refs are attached via
// `Store.putManifestRefs`, never embedded in the envelope.

import type { Hash, SnapshotId } from "../core/ids.ts";
import {
  asHash,
  asSnapshotId,
  concat,
  constantTimeEqual,
  isHash,
  sha256,
} from "../core/ids.ts";
import type { SnapshotEnvelope } from "../core/snapshot-contract.ts";
import type { VirtualTree } from "../vfs/vfs.ts";

/**
 * Full snapshot record: core state plus opaque manifest-ref attachments.
 *
 * Core state (inputs to `SnapshotId`): `parentId`, `tree` (canonical path→blob
 * entries), `timestamp`, `message`, `immutable`.
 *
 * Manifest refs (NOT inputs to `SnapshotId`): `publicManifestRef`,
 * `privateManifestRef`. These are opaque content `Hash`es (populated by C6) or
 * `null`; C4 stores and round-trips them opaquely through the Store
 * `ManifestRefs` attachment and never interprets their contents.
 */
export interface Snapshot {
  /** Opaque content-addressed identity computed from core state only. */
  readonly id: SnapshotId;
  /** Parent snapshot id, or `null` for a root snapshot. */
  readonly parentId: SnapshotId | null;
  /** Core tree: canonical path→blob-id entries derived from a C3 `VirtualTree`. */
  readonly tree: ReadonlyMap<string, Hash>;
  /** Timestamp (milliseconds since epoch, or any monotonic integer). */
  readonly timestamp: number;
  /** Commit-style message. Participates in the id, so it is private. */
  readonly message: string;
  /** Immutable marker. Auto-snapshots may be squashed; explicit ones are immutable. */
  readonly immutable: boolean;
  /** Opaque public manifest content hash, or `null` until C6 populates it. */
  readonly publicManifestRef: Hash | null;
  /** Opaque private manifest content hash, or `null` until C6 populates it. */
  readonly privateManifestRef: Hash | null;
}

/** Magic byte prefix for the core snapshot state framing. */
const SNAPSHOT_CORE_MAGIC = 0x04;
/** Serialized layout version for the core snapshot state. */
const SNAPSHOT_CORE_VERSION = 1;

/**
 * Canonical sorted `[path, blobId]` entries of a tree, sorted by path. Tree
 * identity is this canonical set, so a path-only rename/move changes the id.
 */
export function canonicalTreeEntries(
  tree: ReadonlyMap<string, Hash>,
): ReadonlyArray<readonly [string, Hash]> {
  const entries: Array<readonly [string, Hash]> = Array.from(tree.entries());
  entries.sort((a, b) => {
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    return 0;
  });
  return entries;
}
/**
 * Framed bytes for the canonical tree entries: for each `[path, blobId]` pair
 * (sorted by path), `<path-len>\0<path>\0<blobId-hex(64)>`. The length prefix
 * makes the framing unambiguous and deterministic; the blob id is a fixed
 * 64-char hex string so it needs no length prefix.
 */
function frameTreeEntries(
  entries: ReadonlyArray<readonly [string, Hash]>,
): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const [path, blobId] of entries) {
    const pathBytes = enc.encode(path);
    const lenBytes = enc.encode(String(pathBytes.length));
    chunks.push(
      lenBytes,
      new Uint8Array([0]),
      pathBytes,
      new Uint8Array([0]),
      enc.encode(blobId),
    );
  }
  return concat(chunks);
}

/**
 * Canonical framed bytes for the snapshot's **core state only** — the bytes
 * that are hashed to produce the `SnapshotId` and stored verbatim as
 * `SnapshotEnvelope.serializedBytes`. Manifest refs are deliberately excluded
 * (plan §2 decision 10).
 *
 * Layout:
 *   `snap\0<magic(1)><version(1)><parentId-flag(1)><parentId-hex(0|64)>` +
 *   `<timestamp-decimal>\0` +
 *   `<message-len>\0<message-utf8>` +
 *   `<immutable-flag(1)>` +
 *   `<tree-entries-framed>`.
 *
 * `parentId-flag` is `0x00` for `null` (no id bytes follow) or `0x01` for a
 * present parent id (64 hex bytes follow). `immutable-flag` is `0x00`/`0x01`.
 */
export function snapshotCoreFraming(
  parentId: SnapshotId | null,
  tree: ReadonlyMap<string, Hash>,
  timestamp: number,
  message: string,
  immutable: boolean,
): Uint8Array {
  const enc = new TextEncoder();
  const header = enc.encode("snap");
  const flag = parentId === null ? 0x00 : 0x01;
  const parentBytes = parentId === null ? new Uint8Array(0) : enc.encode(parentId);
  const tsBytes = enc.encode(canonicalDecimal(timestamp));
  const msgBytes = enc.encode(message);
  const msgLenBytes = enc.encode(String(msgBytes.length));
  const entries = canonicalTreeEntries(tree);
  const treeBytes = frameTreeEntries(entries);
  return concat([
    header,
    new Uint8Array([0]),
    new Uint8Array([SNAPSHOT_CORE_MAGIC, SNAPSHOT_CORE_VERSION, flag]),
    parentBytes,
    tsBytes,
    new Uint8Array([0]),
    msgLenBytes,
    new Uint8Array([0]),
    msgBytes,
    new Uint8Array([immutable ? 0x01 : 0x00]),
    treeBytes,
  ]);
}

/**
 * Compute the `SnapshotId` from the snapshot's core state only. Manifest refs
 * are excluded (plan §2 decision 10): `Snapshot.withManifestRefs` preserves the
 * id. A path-only rename/move with unchanged blob ids changes the id because
 * the canonical tree entries change.
 */
export async function computeSnapshotId(
  parentId: SnapshotId | null,
  tree: ReadonlyMap<string, Hash>,
  timestamp: number,
  message: string,
  immutable: boolean,
): Promise<SnapshotId> {
  const framed = snapshotCoreFraming(parentId, tree, timestamp, message, immutable);
  const h = await sha256(framed);
  return asSnapshotId(h);
}

/**
 * Build a `Snapshot` from core state plus (initially null) manifest refs. The
 * `SnapshotId` is computed from the core state; manifest refs are attached
 * opaquely and do not affect the id.
 */
export async function createSnapshot(
  parentId: SnapshotId | null,
  tree: ReadonlyMap<string, Hash> | VirtualTree,
  timestamp: number,
  message: string,
  immutable: boolean,
  manifestRefs?: {
    publicManifestRef?: Hash | null;
    privateManifestRef?: Hash | null;
  },
): Promise<Snapshot> {
  const sourceEntries = "parentId" in tree ? tree.entries : tree;
  const ownedTree = new Map<string, Hash>(sourceEntries);
  const id = await computeSnapshotId(parentId, ownedTree, timestamp, message, immutable);
  return {
    id,
    parentId,
    tree: ownedTree,
    timestamp,
    message,
    immutable,
    publicManifestRef: manifestRefs?.publicManifestRef ?? null,
    privateManifestRef: manifestRefs?.privateManifestRef ?? null,
  };
}

/**
 * Return a new `Snapshot` with the same `SnapshotId` and core state but
 * different manifest refs. The core envelope bytes are unchanged (manifest refs
 * are not part of `serializedBytes`); only the attachment changes. C6 calls
 * this after building a manifest, then upserts the refs via
 * `Store.putManifestRefs`.
 */
export function withManifestRefs(
  snapshot: Snapshot,
  publicManifestRef: Hash | null,
  privateManifestRef: Hash | null,
): Snapshot {
  return {
    id: snapshot.id,
    parentId: snapshot.parentId,
    tree: new Map<string, Hash>(snapshot.tree),
    timestamp: snapshot.timestamp,
    message: snapshot.message,
    immutable: snapshot.immutable,
    publicManifestRef,
    privateManifestRef,
  };
}

/**
 * Build the immutable `SnapshotEnvelope` for a snapshot. `serializedBytes`
 * stores only the core state (the same bytes hashed for the `SnapshotId`);
 * manifest refs are not embedded. The envelope is what `Store.putSnapshot`
 * persists.
 */
export function toSnapshotEnvelope(snapshot: Snapshot): SnapshotEnvelope {
  const serializedBytes = snapshotCoreFraming(
    snapshot.parentId,
    snapshot.tree,
    snapshot.timestamp,
    snapshot.message,
    snapshot.immutable,
  );
  return {
    id: snapshot.id,
    parentId: snapshot.parentId,
    serializedBytes,
  };
}

/**
 * Parse the core state bytes from a `SnapshotEnvelope.serializedBytes` (the
 * inverse of `snapshotCoreFraming`). Returns the core fields; manifest refs are
 * loaded separately from the Store `ManifestRefs` attachment.
 */
export function parseSnapshotCore(
  serializedBytes: Uint8Array,
): {
  parentId: SnapshotId | null;
  tree: ReadonlyMap<string, Hash>;
  timestamp: number;
  message: string;
  immutable: boolean;
} {
  const dec = new TextDecoder();
  const header = new TextEncoder().encode("snap");
  if (serializedBytes.length < header.length + 1 + 3) {
    throw new Error("Invalid snapshot core: too short for header");
  }
  for (let i = 0; i < header.length; i++) {
    if (serializedBytes[i] !== header[i]) {
      throw new Error("Invalid snapshot core: bad header");
    }
  }
  let i = header.length;
  if (serializedBytes[i] !== 0) {
    throw new Error("Invalid snapshot core: bad header delimiter");
  }
  i++;
  if (serializedBytes[i] !== SNAPSHOT_CORE_MAGIC) {
    throw new Error("Invalid snapshot core: bad magic");
  }
  i++;
  if (serializedBytes[i] !== SNAPSHOT_CORE_VERSION) {
    throw new Error(`Unsupported snapshot core version: ${serializedBytes[i]}`);
  }
  i++;
  const flag = serializedBytes[i]!;
  if (flag !== 0x00 && flag !== 0x01) {
    throw new Error(`Invalid snapshot core: bad parentId flag ${flag}`);
  }
  i++;
  let parentId: SnapshotId | null;
  if (flag === 0x00) {
    parentId = null;
  } else {
    if (i + 64 > serializedBytes.length) {
      throw new Error("Invalid snapshot core: parentId truncated");
    }
    const parentHex = dec.decode(serializedBytes.subarray(i, i + 64));
    if (!isHash(parentHex)) {
      throw new Error("Invalid snapshot core: bad parentId hash");
    }
    parentId = asSnapshotId(parentHex);
    i += 64;
  }
  // `<timestamp-decimal>\0`
  let nul = -1;
  for (let j = i; j < serializedBytes.length; j++) {
    if (serializedBytes[j] === 0) {
      nul = j;
      break;
    }
  }
  if (nul < 0) throw new Error("Invalid snapshot core: missing timestamp delimiter");
  const tsStr = dec.decode(serializedBytes.subarray(i, nul));
  const timestamp = parseCanonicalInt(tsStr, "timestamp");
  i = nul + 1;
  // `<message-len>\0<message-utf8>`
  nul = -1;
  for (let j = i; j < serializedBytes.length; j++) {
    if (serializedBytes[j] === 0) {
      nul = j;
      break;
    }
  }
  if (nul < 0) throw new Error("Invalid snapshot core: missing message length delimiter");
  const msgLenStr = dec.decode(serializedBytes.subarray(i, nul));
  const msgLen = parseCanonicalInt(msgLenStr, "message length");
  i = nul + 1;
  if (i + msgLen > serializedBytes.length) {
    throw new Error("Invalid snapshot core: message truncated");
  }
  const message = dec.decode(serializedBytes.subarray(i, i + msgLen));
  i += msgLen;
  // `<immutable-flag(1)>`
  if (i >= serializedBytes.length) {
    throw new Error("Invalid snapshot core: missing immutable flag");
  }
  const immFlag = serializedBytes[i]!;
  if (immFlag !== 0x00 && immFlag !== 0x01) {
    throw new Error(`Invalid snapshot core: bad immutable flag ${immFlag}`);
  }
  const immutable = immFlag === 0x01;
  i++;
  // Remaining: tree entries framing.
  const treeBytes = serializedBytes.subarray(i);
  const tree = parseTreeEntries(treeBytes);
  return { parentId, tree, timestamp, message, immutable };
}

/**
 * Parse the framed tree entries (the inverse of `frameTreeEntries`). Each entry
 * is `<path-len>\0<path>\0<blobId-hex(64)>`.
 */
function parseTreeEntries(data: Uint8Array): ReadonlyMap<string, Hash> {
  const dec = new TextDecoder();
  const map = new Map<string, Hash>();
  let i = 0;
  while (i < data.length) {
    // `<path-len>\0`
    let nul = -1;
    for (let j = i; j < data.length; j++) {
      if (data[j] === 0) {
        nul = j;
        break;
      }
    }
    if (nul < 0) throw new Error("Invalid snapshot core: missing path length delimiter");
    const lenStr = dec.decode(data.subarray(i, nul));
    const pathLen = parseCanonicalInt(lenStr, "path length");
    i = nul + 1;
    if (i + pathLen > data.length) {
      throw new Error("Invalid snapshot core: path truncated");
    }
    const path = dec.decode(data.subarray(i, i + pathLen));
    i += pathLen;
    // `\0` separator before blobId
    if (i >= data.length || data[i] !== 0) {
      throw new Error("Invalid snapshot core: missing path/blobId delimiter");
    }
    i++;
    if (i + 64 > data.length) {
      throw new Error("Invalid snapshot core: blobId truncated");
    }
    const blobHex = dec.decode(data.subarray(i, i + 64));
    if (!isHash(blobHex)) {
      throw new Error("Invalid snapshot core: bad blobId hash");
    }
    i += 64;
    map.set(path, asHash(blobHex));
  }
  return map;
}

/**
 * Reconstruct a full `Snapshot` from a stored envelope plus the manifest refs
 * loaded from the Store attachment. The `id` is taken from the envelope; when
 * `verify` is true, the parsed core must be in canonical byte form and the
 * envelope id must match the recomputed core id.
 */
export async function fromSnapshotEnvelope(
  env: SnapshotEnvelope,
  manifestRefs: { publicManifestRef: Hash | null; privateManifestRef: Hash | null },
  verify: boolean = true,
): Promise<Snapshot> {
  const core = parseSnapshotCore(env.serializedBytes);
  if (env.parentId !== core.parentId) {
    throw new Error(
      `Snapshot parentId mismatch: envelope=${env.parentId ?? "null"} core=${core.parentId ?? "null"}`,
    );
  }
  const canonicalBytes = snapshotCoreFraming(
    core.parentId,
    core.tree,
    core.timestamp,
    core.message,
    core.immutable,
  );
  if (verify && !constantTimeEqual(canonicalBytes, env.serializedBytes)) {
    throw new Error("Snapshot core is not canonical");
  }
  const id = asSnapshotId(await sha256(canonicalBytes));
  if (verify && id !== env.id) {
    throw new Error(
      `Snapshot id mismatch: envelope=${env.id} recomputed=${id}`,
    );
  }
  return {
    id: env.id,
    parentId: core.parentId,
    tree: core.tree,
    timestamp: core.timestamp,
    message: core.message,
    immutable: core.immutable,
    publicManifestRef: manifestRefs.publicManifestRef,
    privateManifestRef: manifestRefs.privateManifestRef,
  };
}

/**
 * Persist a snapshot to the store: puts the immutable `SnapshotEnvelope` (core
 * state only) and upserts the `ManifestRefs` attachment. The envelope is
 * append-only/idempotent; the attachment is the sole upsert surface for refs.
 */
export function saveSnapshot(
  snapshot: Snapshot,
  store: {
    putSnapshot(env: SnapshotEnvelope): void;
    putManifestRefs(
      snapshotId: SnapshotId,
      refs: { publicManifestRef: Hash | null; privateManifestRef: Hash | null },
    ): void;
  },
): void {
  const env = toSnapshotEnvelope(snapshot);
  store.putSnapshot(env);
  store.putManifestRefs(snapshot.id, {
    publicManifestRef: snapshot.publicManifestRef,
    privateManifestRef: snapshot.privateManifestRef,
  });
}

/**
 * Load a snapshot from the store: reads the immutable envelope and the manifest
 * refs attachment, and reconstructs the full `Snapshot`. Throws `NotFound`
 * (from the store) if the envelope is missing.
 */
export async function loadSnapshot(
  id: SnapshotId,
  store: {
    getSnapshot(id: SnapshotId): SnapshotEnvelope;
    getManifestRefs(id: SnapshotId): {
      publicManifestRef: Hash | null;
      privateManifestRef: Hash | null;
    };
  },
  verify: boolean = true,
): Promise<Snapshot> {
  const env = store.getSnapshot(id);
  const refs = store.getManifestRefs(id);
  return fromSnapshotEnvelope(env, refs, verify);
}

/** Format a non-negative integer as canonical decimal (no leading zeros). */
function canonicalDecimal(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new TypeError(`Expected non-negative safe integer: ${n}`);
  }
  return String(n);
}

/** Parse a canonical decimal integer field, rejecting non-canonical forms. */
function parseCanonicalInt(s: string, field: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(s)) {
    throw new Error(`Invalid snapshot core: bad ${field} "${s}"`);
  }
  const n = Number(s);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`Invalid snapshot core: ${field} out of safe range "${s}"`);
  }
  return n;
}
