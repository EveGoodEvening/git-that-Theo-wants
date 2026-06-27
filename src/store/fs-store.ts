// C8 optional real-FS `Store` backend against a `.gtw/objects` directory.
//
// This is the **secondary** persistence path (plan C8 Blocker/Deferred); the
// in-memory `MemoryStore` remains the primary backend. `FsStore` implements
// the C2 `Store` interface — persisting and retrieving `ContentObject`,
// `SignedAclNode`, `SnapshotEnvelope`, and the mutable `ManifestRefs`
// attachment — against an on-disk object store rooted at a caller-supplied
// directory (typically `.gtw`).
//
// Layout:
//   <root>/objects/<id>            — serialized `ContentObject` (content graph)
//   <root>/acls/<id>               — serialized `SignedAclNode` (ACL graph)
//   <root>/snapshots/<id>          — serialized `SnapshotEnvelope`
//   <root>/manifest-refs/<id>.json — `ManifestRefs` attachment (JSON)
//
// Each immutable object is stored as the bytes produced by its canonical
// `serialize*` function. On read, the id is re-derived and verified, so
// **corrupt-object detection** is enforced at the parse boundary: a truncated,
// bit-flipped, or otherwise tampered object file causes `getObject`/`getAcl`/
// `getSnapshot` to throw `CorruptObject`, rather than silently returning wrong
// data.
//
// The C2 `Store` interface is synchronous, but the canonical
// `parseContentObject` / `parseSignedAclNode` verifiers are async (they hash).
// To keep reads synchronous, `FsStore` re-derives the id synchronously with
// `node:crypto`'s `createHash("sha256")` (available in both Node and Bun) over
// the exact framing the canonical serializer writes, and compares it to the
// expected id. The structural recovery of `kind`/`bytes`/record fields reuses
// the canonical sync helpers (`parseCanonicalAclRecord`, the framing layout).
// `parseSnapshotEnvelope` is already sync and is used directly.
//
// Conflict semantics mirror `MemoryStore`: the three immutable graphs are
// append-only/idempotent. An identical re-put is a no-op; a conflicting re-put
// (same id, different immutable data) throws `ObjectConflict`/`AclConflict`/
// `SnapshotConflict`. `putManifestRefs` is the sole upsert surface. There are
// no delete methods (deletion/GC is deferred, plan §5).
//
// `listSnapshots` returns ids in insertion order per the Store contract. The
// order is persisted to `snapshot-order.txt` so it survives process restarts.

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AclNodeId, Hash, SnapshotId } from "../core/ids.ts";
import { asHash, isHash, parseDecimalLen } from "../core/ids.ts";
import { parseSnapshotCore } from "../snapshot/snapshot.ts";
import type { ContentObject, ContentKind } from "../core/object.ts";
import { serializeContentObject } from "../core/object.ts";
import type { SignedAclNode } from "../core/acl.ts";
import {
  serializeSignedAclNode,
  parseCanonicalAclRecord,
} from "../core/acl.ts";
import type { SnapshotEnvelope } from "../core/snapshot-contract.ts";
import {
  serializeSnapshotEnvelope,
  parseSnapshotEnvelope,
} from "../core/snapshot-contract.ts";
import {
  AclConflict,
  NotFound,
  ObjectConflict,
  SnapshotConflict,
  type ManifestRefs,
  type Store,
} from "./store.ts";

/**
 * Typed error raised when an on-disk object file is present but cannot be
 * parsed/verified (corruption: truncation, bit-flip, wrong framing, or a
 * recomputed-id mismatch). This is the corrupt-object detection signal.
 */
export class CorruptObject extends Error {
  readonly kind: "object" | "acl" | "snapshot" | "manifestRefs";
  readonly id: string;

  constructor(
    kind: CorruptObject["kind"],
    id: string,
    message?: string,
  ) {
    super(
      message ??
        `CorruptObject (${kind}): ${id} failed to parse/verify on disk`,
    );
    this.name = "CorruptObject";
    this.kind = kind;
    this.id = id;
  }
}

/** Synchronous SHA-256 over `bytes`, returning a branded `Hash`. */
function sha256Sync(bytes: Uint8Array): Hash {
  return asHash(createHash("sha256").update(bytes).digest("hex"));
}

/** Byte-for-byte equality of two `Uint8Array`s. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Structural equality of two `ContentObject` envelopes (same kind + bytes). */
function contentObjectEqual(a: ContentObject, b: ContentObject): boolean {
  return a.kind === b.kind && bytesEqual(a.bytes, b.bytes);
}

/** Structural equality of two `SignedAclNode`s (same record + signature). */
function signedAclNodeEqual(a: SignedAclNode, b: SignedAclNode): boolean {
  if (a.record.subject !== b.record.subject) return false;
  if (a.record.object !== b.record.object) return false;
  if (a.record.permissions.size !== b.record.permissions.size) return false;
  for (const p of a.record.permissions) {
    if (!b.record.permissions.has(p)) return false;
  }
  return bytesEqual(a.signature, b.signature);
}

/** Structural equality of two `SnapshotEnvelope` cores (parentId + bytes). */
function snapshotEnvelopeEqual(
  a: SnapshotEnvelope,
  b: SnapshotEnvelope,
): boolean {
  return a.parentId === b.parentId && bytesEqual(a.serializedBytes, b.serializedBytes);
}

/** Structural equality of two `ManifestRefs` (both `Hash | null` fields match). */
function manifestRefsEqual(a: ManifestRefs, b: ManifestRefs): boolean {
  return (
    a.publicManifestRef === b.publicManifestRef &&
    a.privateManifestRef === b.privateManifestRef
  );
}

/**
 * Synchronously parse and verify a `ContentObject` from its serialized bytes.
 *
 * Layout (from `serializeContentObject`):
 *   `contentFraming(kind, bytes)` || `\0` || `<id-hex(64)>`
 * where `contentFraming` = `content\0<magic(1)><version(1)><kindTag(1)><len>\0<bytes>`.
 *
 * Verification: recompute `sha256(contentFraming)` and compare to `expectedId`.
 * Throws `CorruptObject` on any mismatch or malformed framing.
 */
function parseContentObjectSync(
  data: Uint8Array,
  expectedId: Hash,
): ContentObject {
  // Split off the trailing `<id-hex(64)>` after the last NUL.
  let lastNul = -1;
  for (let i = data.length - 1; i >= 0; i--) {
    if (data[i] === 0) {
      lastNul = i;
      break;
    }
  }
  if (lastNul < 0) {
    throw new CorruptObject("object", expectedId, "missing trailing NUL delimiter");
  }
  const idHex = new TextDecoder().decode(data.subarray(lastNul + 1));
  if (idHex !== expectedId) {
    throw new CorruptObject(
      "object",
      expectedId,
      `embedded id ${idHex} does not match expected ${expectedId}`,
    );
  }
  // `framing` is exactly `contentFraming(kind, bytes)`.
  const framing = data.subarray(0, lastNul);
  const recomputed = sha256Sync(framing);
  if (recomputed !== expectedId) {
    throw new CorruptObject(
      "object",
      expectedId,
      `recomputed content hash ${recomputed} does not match ${expectedId}`,
    );
  }
  // Recover kind + bytes from the framing. Layout:
  //   "content" \0 <magic(1)> <version(1)> <kindTag(1)> <len-decimal> \0 <bytes>
  const TAG = "content";
  const tagBytes = new TextEncoder().encode(TAG);
  const headerLen = tagBytes.length + 1 + 3; // tag + NUL + magic + version + kindTag
  if (framing.length < headerLen) {
    throw new CorruptObject("object", expectedId, "framing too short for header");
  }
  for (let i = 0; i < tagBytes.length; i++) {
    if (framing[i] !== tagBytes[i]) {
      throw new CorruptObject("object", expectedId, "bad content tag");
    }
  }
  if (framing[tagBytes.length] !== 0) {
    throw new CorruptObject("object", expectedId, "missing NUL after content tag");
  }
  const magic = framing[tagBytes.length + 1];
  const version = framing[tagBytes.length + 2];
  const kindTagByte = framing[tagBytes.length + 3];
  if (magic !== 0x01) {
    throw new CorruptObject("object", expectedId, `bad magic 0x${magic.toString(16)}`);
  }
  if (version !== 1) {
    throw new CorruptObject("object", expectedId, `unsupported version ${version}`);
  }
  const kind: ContentKind | null =
    kindTagByte === 0x00 ? "blob" : kindTagByte === 0x01 ? "secret-blob" : null;
  if (kind === null) {
    throw new CorruptObject(
      "object",
      expectedId,
      `bad kind tag 0x${kindTagByte.toString(16)}`,
    );
  }
  // Parse `<len-decimal>\0<bytes>`.
  const lenStart = headerLen;
  let nulAfterLen = -1;
  for (let i = lenStart; i < framing.length; i++) {
    if (framing[i] === 0) {
      nulAfterLen = i;
      break;
    }
  }
  if (nulAfterLen < 0) {
    throw new CorruptObject("object", expectedId, "missing NUL after length");
  }
  const lenStr = new TextDecoder().decode(framing.subarray(lenStart, nulAfterLen));
  let len: number;
  try {
    len = parseDecimalLen(lenStr);
  } catch {
    throw new CorruptObject("object", expectedId, `bad length field "${lenStr}"`);
  }
  const body = framing.subarray(nulAfterLen + 1);
  if (body.length !== len) {
    throw new CorruptObject(
      "object",
      expectedId,
      `body length mismatch: declared ${len}, actual ${body.length}`,
    );
  }
  return { id: expectedId, kind, bytes: new Uint8Array(body) };
}

/**
 * Synchronously parse and verify a `SignedAclNode` from its serialized bytes.
 *
 * Layout (from `serializeSignedAclNode`):
 *   `<canonicalRecord>` || `<signature(32)>` || `<id-hex(64)>` || `\0`
 *
 * Verification: recompute `sha256(canonicalRecord || signature)` and compare to
 * `expectedId`. Throws `CorruptObject` on any mismatch or malformed framing.
 */
function parseSignedAclNodeSync(
  data: Uint8Array,
  expectedId: AclNodeId,
): SignedAclNode {
  if (data.length === 0 || data[data.length - 1] !== 0) {
    throw new CorruptObject("acl", expectedId, "missing trailing NUL delimiter");
  }
  // Trailing `\0`, then 64-byte id-hex before it, then 32-byte signature.
  const idHexEnd = data.length - 1;
  const idHexStart = idHexEnd - 64;
  const sigStart = idHexStart - 32;
  if (idHexStart < 0 || sigStart < 0) {
    throw new CorruptObject("acl", expectedId, "serialization too short");
  }
  const idHex = new TextDecoder().decode(data.subarray(idHexStart, idHexEnd));
  if (idHex !== expectedId) {
    throw new CorruptObject(
      "acl",
      expectedId,
      `embedded id ${idHex} does not match expected ${expectedId}`,
    );
  }
  const signature = new Uint8Array(data.subarray(sigStart, idHexStart));
  const recordBytes = data.subarray(0, sigStart);
  // Node id = sha256(canonicalRecord || signature).
  const idInput = new Uint8Array(recordBytes.length + signature.length);
  idInput.set(recordBytes, 0);
  idInput.set(signature, recordBytes.length);
  const recomputed = sha256Sync(idInput) as unknown as AclNodeId;
  if (recomputed !== expectedId) {
    throw new CorruptObject(
      "acl",
      expectedId,
      `recomputed node id ${recomputed} does not match ${expectedId}`,
    );
  }
  // Recover the record fields. `parseCanonicalAclRecord` is synchronous.
  const record = parseCanonicalAclRecord(recordBytes);
  return { id: expectedId, record, signature };
}

/**
 * Optional real-FS `Store` backend. Persists the C1 object model to an
 * on-disk object store. The `rootDir` is created on construction; the four
 * subdirectories (`objects`, `acls`, `snapshots`, `manifest-refs`) are created
 * lazily on first write to a given graph.
 *
 * Corrupt-object detection: every read re-derives and verifies the object's id
 * (content hash / node id / envelope id) synchronously. A tampered or
 * truncated file throws `CorruptObject` rather than returning wrong data.
 */
export class FsStore implements Store {
  private readonly rootDir: string;
  private readonly objectsDir: string;
  private readonly aclsDir: string;
  private readonly snapshotsDir: string;
  private readonly manifestRefsDir: string;
  /**
   * Insertion-order index for `listSnapshots` (Store contract: ids returned in
   * insertion order). Persisted as a newline-delimited file so order survives
   * process restarts. A snapshot id is appended exactly once, the first time
   * `putSnapshot` stores a new envelope.
   */
  private readonly snapshotOrderFile: string;

  /**
   * @param rootDir Root directory for the on-disk store (e.g. `.gtw`). Four
   *   subdirectories are used: `objects`, `acls`, `snapshots`, `manifest-refs`.
   *   The directory is created if it does not exist.
   */
  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.objectsDir = join(rootDir, "objects");
    this.aclsDir = join(rootDir, "acls");
    this.snapshotsDir = join(rootDir, "snapshots");
    this.manifestRefsDir = join(rootDir, "manifest-refs");
    this.snapshotOrderFile = join(rootDir, "snapshot-order.txt");
    mkdirSync(this.rootDir, { recursive: true });
  }

  private ensureDir(dir: string): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  /**
   * Append `id` to the persisted insertion-order index, unless already
   * present. The index is a newline-delimited list of `SnapshotId`s; an
   * id appears at most once, at the position of its first `putSnapshot`.
   */
  private appendSnapshotOrder(id: SnapshotId): void {
    const existing = this.readSnapshotOrder();
    if (existing.includes(id)) return;
    const next = [...existing, id];
    writeFileSync(this.snapshotOrderFile, next.join("\n") + "\n", "utf8");
  }

  /**
   * Read the persisted insertion-order index. Returns `[]` when absent or
   * empty. Trailing newline is tolerated; blank lines are skipped.
   */
  private readSnapshotOrder(): SnapshotId[] {
    if (!existsSync(this.snapshotOrderFile)) return [];
    let text: string;
    try {
      text = readFileSync(this.snapshotOrderFile, "utf8");
    } catch {
      return [];
    }
    return text.split("\n").filter((l) => l.length > 0) as SnapshotId[];
  }

  // --- Content graph ---

  putObject(obj: ContentObject): void {
    const path = join(this.objectsDir, obj.id);
    if (existsSync(path)) {
      const existing = this.readAndParseObject(obj.id);
      if (contentObjectEqual(existing, obj)) return;
      throw new ObjectConflict(
        obj.id,
        `ObjectConflict: object ${obj.id} already exists with different immutable data`,
      );
    }
    this.ensureDir(this.objectsDir);
    writeFileSync(path, serializeContentObject(obj));
  }

  getObject(id: Hash): ContentObject {
    if (!existsSync(join(this.objectsDir, id))) throw new NotFound("object", id);
    return this.readAndParseObject(id);
  }

  hasObject(id: Hash): boolean {
    return existsSync(join(this.objectsDir, id));
  }

  private readAndParseObject(id: Hash): ContentObject {
    const path = join(this.objectsDir, id);
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(path);
    } catch (e) {
      throw new CorruptObject("object", id, (e as Error).message);
    }
    try {
      return parseContentObjectSync(bytes, id);
    } catch (e) {
      if (e instanceof CorruptObject) throw e;
      throw new CorruptObject("object", id, (e as Error).message);
    }
  }

  // --- ACL metadata graph ---

  putAcl(node: SignedAclNode): void {
    const path = join(this.aclsDir, node.id);
    if (existsSync(path)) {
      const existing = this.readAndParseAcl(node.id);
      if (signedAclNodeEqual(existing, node)) return;
      throw new AclConflict(
        node.id,
        `AclConflict: ACL node ${node.id} already exists with different immutable data`,
      );
    }
    this.ensureDir(this.aclsDir);
    writeFileSync(path, serializeSignedAclNode(node));
  }

  getAcl(id: AclNodeId): SignedAclNode {
    if (!existsSync(join(this.aclsDir, id))) throw new NotFound("acl", id);
    return this.readAndParseAcl(id);
  }

  private readAndParseAcl(id: AclNodeId): SignedAclNode {
    const path = join(this.aclsDir, id);
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(path);
    } catch (e) {
      throw new CorruptObject("acl", id, (e as Error).message);
    }
    try {
      return parseSignedAclNodeSync(bytes, id);
    } catch (e) {
      if (e instanceof CorruptObject) throw e;
      throw new CorruptObject("acl", id, (e as Error).message);
    }
  }

  // --- Immutable snapshot envelopes ---

  putSnapshot(env: SnapshotEnvelope): void {
    const path = join(this.snapshotsDir, env.id);
    if (existsSync(path)) {
      const existing = this.readAndParseSnapshot(env.id);
      if (snapshotEnvelopeEqual(existing, env)) return;
      throw new SnapshotConflict(
        env.id,
        `SnapshotConflict: SnapshotId ${env.id} already exists with different immutable core bytes`,
      );
    }
    this.ensureDir(this.snapshotsDir);
    writeFileSync(path, serializeSnapshotEnvelope(env));
    // Record insertion order for `listSnapshots` (Store contract).
    this.appendSnapshotOrder(env.id);
  }

  getSnapshot(id: SnapshotId): SnapshotEnvelope {
    if (!existsSync(join(this.snapshotsDir, id))) throw new NotFound("snapshot", id);
    return this.readAndParseSnapshot(id);
  }

  listSnapshots(): SnapshotId[] {
    if (!existsSync(this.snapshotsDir)) return [];
    // Store contract: ids returned in insertion order. The persisted
    // `snapshot-order.txt` index records the first-put position of each id.
    // Any id present on disk but missing from the index (e.g. a file written
    // out-of-band) is appended in lexicographic order as a deterministic
    // fallback; any index entry whose file is absent is dropped.
    const ordered = this.readSnapshotOrder();
    const onDisk = new Set<string>(readdirSync(this.snapshotsDir) as string[]);
    const out: SnapshotId[] = [];
    const seen = new Set<string>();
    for (const id of ordered) {
      if (onDisk.has(id) && !seen.has(id)) {
        out.push(id as SnapshotId);
        seen.add(id);
      }
    }
    for (const id of [...onDisk].sort()) {
      if (!seen.has(id)) out.push(id as SnapshotId);
    }
    return out;
  }

  private readAndParseSnapshot(id: SnapshotId): SnapshotEnvelope {
    const path = join(this.snapshotsDir, id);
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(path);
    } catch (e) {
      throw new CorruptObject("snapshot", id, (e as Error).message);
    }
    let env: SnapshotEnvelope;
    try {
      env = parseSnapshotEnvelope(bytes);
    } catch (e) {
      if (e instanceof CorruptObject) throw e;
      throw new CorruptObject("snapshot", id, (e as Error).message);
    }
    // The filename must match the envelope's carried id.
    if (env.id !== id) {
      throw new CorruptObject(
        "snapshot",
        id,
        `file contains envelope with id ${env.id}, expected ${id}`,
      );
    }
    // Recompute the SnapshotId from the core `serializedBytes` (the
    // content-addressed identity is `sha256(snapshotCoreFraming(...))`, and
    // `serializedBytes` IS that framing). A bit-flip, truncation, or any
    // tampering of the core bytes changes the recomputed id, so this rejects
    // corrupt core bytes that the outer-envelope parser would otherwise accept
    // (the envelope header carries the id and parentId redundantly, so a
    // same-length core bit-flip can slip past header-only verification).
    const recomputedCoreId = sha256Sync(env.serializedBytes) as unknown as SnapshotId;
    if (recomputedCoreId !== id) {
      throw new CorruptObject(
        "snapshot",
        id,
        `recomputed core id ${recomputedCoreId} does not match ${id} (corrupt serializedBytes)`,
      );
    }
    // Reject parent/core mismatches: the `parentId` in the envelope header must
    // match the `parentId` encoded inside the core `serializedBytes`. A
    // tampered envelope that swaps the header parentId while leaving the core
    // bytes (and thus the id) unchanged would otherwise be accepted.
    let coreParent: SnapshotId | null;
    try {
      coreParent = parseSnapshotCore(env.serializedBytes).parentId;
    } catch (e) {
      throw new CorruptObject("snapshot", id, (e as Error).message);
    }
    if (coreParent !== env.parentId) {
      throw new CorruptObject(
        "snapshot",
        id,
        `envelope parentId ${env.parentId} does not match core parentId ${coreParent}`,
      );
    }
    return env;
  }

  // --- Mutable manifest-ref attachment ---

  putManifestRefs(snapshotId: SnapshotId, refs: ManifestRefs): void {
    this.ensureDir(this.manifestRefsDir);
    const path = join(this.manifestRefsDir, `${snapshotId}.json`);
    if (existsSync(path)) {
      const current = this.readManifestRefsFile(snapshotId);
      if (manifestRefsEqual(current, refs)) return;
    }
    writeFileSync(
      path,
      JSON.stringify({
        publicManifestRef: refs.publicManifestRef,
        privateManifestRef: refs.privateManifestRef,
      }),
    );
  }

  getManifestRefs(snapshotId: SnapshotId): ManifestRefs {
    const path = join(this.manifestRefsDir, `${snapshotId}.json`);
    if (!existsSync(path)) {
      return { publicManifestRef: null, privateManifestRef: null };
    }
    return this.readManifestRefsFile(snapshotId);
  }

  private readManifestRefsFile(snapshotId: SnapshotId): ManifestRefs {
    const path = join(this.manifestRefsDir, `${snapshotId}.json`);
    let obj: unknown;
    try {
      obj = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new CorruptObject("manifestRefs", snapshotId, (e as Error).message);
    }
    // Strict validation: both fields must be present and either null or a
    // valid SHA-256 hex hash. A missing field, wrong type, or non-canonical
    // hash string is corruption (CorruptObject), not a silent default.
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
      throw new CorruptObject(
        "manifestRefs",
        snapshotId,
        "manifest-refs JSON is not an object",
      );
    }
    const rec = obj as Record<string, unknown>;
    if (!("publicManifestRef" in rec) || !("privateManifestRef" in rec)) {
      throw new CorruptObject(
        "manifestRefs",
        snapshotId,
        "manifest-refs JSON missing required field(s)",
      );
    }
    const pub = rec.publicManifestRef;
    const priv = rec.privateManifestRef;
    if (pub !== null && !isHash(pub)) {
      throw new CorruptObject(
        "manifestRefs",
        snapshotId,
        `manifest-refs publicManifestRef is not a valid SHA-256 hash: ${String(pub)}`,
      );
    }
    if (priv !== null && !isHash(priv)) {
      throw new CorruptObject(
        "manifestRefs",
        snapshotId,
        `manifest-refs privateManifestRef is not a valid SHA-256 hash: ${String(priv)}`,
      );
    }
    return {
      publicManifestRef: pub as Hash | null,
      privateManifestRef: priv as Hash | null,
    };
  }
}
