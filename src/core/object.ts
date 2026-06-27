// C1 core object model: content-addressed blobs and the ContentObject envelope.
//
// Two graphs are kept strictly separate (plan §2 decision 1):
//   1. The *content graph*: `Blob` and `ContentObject` are content-addressed by
//      SHA-256 over framed bytes. Dedup is preserved because the hash depends
//      only on content, never on access policy.
//   2. The *ACL metadata graph* (see `acl.ts`): signed access records layered
//      over content objects. ACL bytes never enter the content hash.
//
// `ContentObject` is the storage seam: a `{ id, kind, bytes }` envelope where
// `kind` is `'blob'` (plain content) or `'secret-blob'` (an encrypted envelope
// whose crypto is added in C5). C1 supports the `secret-blob` kind only as an
// envelope shape — it does not perform any crypto.

import {
  type Hash,
  asHash,
  concat,
  frameBytes,
  isHash,
  parseDecimalLen,
  sha256,
} from "./ids.ts";

/** A raw content-addressed byte blob. */
export interface Blob {
  /** Content hash over the framed bytes `blob <len>\0<bytes>`. */
  readonly id: Hash;
  readonly bytes: Uint8Array;
}

/** Kind tag for the `ContentObject` storage envelope. */
export type ContentKind = "blob" | "secret-blob";

/** Magic byte prefix for the serialized `ContentObject` envelope. */
const CONTENT_MAGIC = 0x01;
/** Serialized layout version for `ContentObject`. */
const CONTENT_VERSION = 1;

/**
 * Storage-envelope over a byte payload. The store (C2) persists and retrieves
 * `ContentObject` values; it is crypto-agnostic. For `kind: 'blob'` the
 * `bytes` are plaintext content; for `kind: 'secret-blob'` the `bytes` are an
 * opaque ciphertext envelope whose framing/crypto is defined in C5.
 *
 * The `id` is the content hash of the *envelope* (kind + payload), so two
 * objects with the same payload but different kinds have different ids. This
 * keeps plain and secret blobs addressable separately while reusing the same
 * store seam.
 */
export interface ContentObject {
  /** Content hash over the serialized envelope (kind + bytes). */
  readonly id: Hash;
  readonly kind: ContentKind;
  readonly bytes: Uint8Array;
}

/** Kind tag encoded as a single ASCII byte in the serialized envelope. */
function kindTag(kind: ContentKind): number {
  if (kind === "blob") return 0x00;
  if (kind === "secret-blob") return 0x01;
  throw new TypeError(`Unknown ContentKind: ${kind as string}`);
}

function tagKind(tag: number): ContentKind {
  if (tag === 0x00) return "blob";
  if (tag === 0x01) return "secret-blob";
  throw new TypeError(`Unknown ContentKind tag byte: ${tag}`);
}

/**
 * Framed bytes used to hash a `Blob`: the ASCII framing `blob <len>\0` followed
 * by the raw bytes. The length prefix prevents prefix-collision between blobs
 * of different sizes and makes the hash unambiguous.
 */
export function blobFraming(bytes: Uint8Array): Uint8Array {
  return frameBytes("blob", bytes);
}

/** Compute the content `Hash` of a blob over `blob <len>\0<bytes>`. */
export async function blobId(bytes: Uint8Array): Promise<Hash> {
  return sha256(blobFraming(bytes));
}

/** Create a `Blob` from raw bytes, computing its content id. The returned
 *  `bytes` is an owned copy so callers cannot mutate the input after hashing. */
export async function createBlob(bytes: Uint8Array): Promise<Blob> {
  const owned = new Uint8Array(bytes);
  return { id: await blobId(owned), bytes: owned };
}

/**
 * Serialize a `Blob` to framed bytes `blob <len>\0<id-hex>\0<bytes>`. The id is
 * included so the serialized form is self-describing and round-trips without
 * recomputation. The id is *not* part of the content hash (only `blob <len>\0
 * <bytes>` is hashed); it is carried alongside for storage convenience.
 */
export function serializeBlob(blob: Blob): Uint8Array {
  const idHex = new TextEncoder().encode(blob.id);
  const framed = frameBytes("blob", blob.bytes);

  // Layout: `blob <len>\0<bytes>` (framed) then `\0<id-hex>`.
  return concat([framed, new Uint8Array([0]), idHex]);
}

/**
 * Parse a `Blob` from `serializeBlob` output, verifying the embedded id matches
 * the recomputed content hash over `blob <len>\0<bytes>`. Async because the
 * verification hashes the bytes.
 */
export async function parseBlob(data: Uint8Array): Promise<Blob> {
  // The framing is `blob <len>\0<bytes>\0<id-hex>`. Split off the id-hex tail
  // by finding the last NUL byte.
  let lastNul = -1;
  for (let i = data.length - 1; i >= 0; i--) {
    if (data[i] === 0) {
      lastNul = i;
      break;
    }
  }
  if (lastNul < 0) throw new Error("Invalid Blob serialization: missing id delimiter");
  const idHex = new TextDecoder().decode(data.subarray(lastNul + 1));
  if (!isHash(idHex)) throw new Error("Invalid Blob serialization: bad id hash");
  const head = data.subarray(0, lastNul); // `blob <len>\0<bytes>`
  const parsed = parseFramedBytes("blob", head);
  // Copy the payload before any await: `parsed` is a view into `head`, which is
  // a view into the caller's `data`. The await below yields control back to the
  // caller, who could mutate `data` (and thus `parsed`) before the id is
  // recomputed. The owned copy is what gets hashed and returned, isolating the
  // blob from post-parse mutation of the input buffer.
  const owned = new Uint8Array(parsed);
  const recomputed = await sha256(blobFraming(owned));
  if (recomputed !== idHex) {
    throw new Error("Invalid Blob serialization: id does not match content hash");
  }
  return { id: asHash(idHex), bytes: owned };
}

/**
 * Parse `<tag> <len>\0<bytes>` framing from `data`, returning the inner bytes.
 * Throws if the tag or length does not match.
 */
function parseFramedBytes(tag: string, data: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(`${tag} `);
  // Find the NUL that terminates the `<tag> <len>` header.
  let nul = -1;
  for (let i = prefix.length; i < data.length; i++) {
    if (data[i] === 0) {
      nul = i;
      break;
    }
  }
  if (nul < 0) throw new Error(`Invalid framing: missing NUL for tag "${tag}"`);
  // Verify the `<tag> ` prefix.
  for (let i = 0; i < prefix.length; i++) {
    if (data[i] !== prefix[i]) {
      throw new Error(`Invalid framing: bad tag prefix for "${tag}"`);
    }
  }
  const lenStr = new TextDecoder().decode(data.subarray(prefix.length, nul));
  let len: number;
  try {
    len = parseDecimalLen(lenStr);
  } catch {
    throw new Error(`Invalid framing: bad length "${lenStr}" for tag "${tag}"`);
  }
  const body = data.subarray(nul + 1);
  if (body.length !== len) {
    throw new Error(
      `Invalid framing: length mismatch for "${tag}" (header=${len}, actual=${body.length})`,
    );
  }
  return body;
}

/**
 * Framed bytes used to hash a `ContentObject` envelope:
 * `content\0<version(1)><kindTag(1)><len>\0<bytes>` — a magic+version header
 * followed by the kind tag and a length-framed payload. The kind participates
 * in the hash so a plain blob and a secret blob carrying the same payload have
 * distinct ids.
 */
export function contentFraming(kind: ContentKind, bytes: Uint8Array): Uint8Array {
  const header = new TextEncoder().encode("content");
  const lenBytes = new TextEncoder().encode(String(bytes.length));
  return concat([
    header,
    new Uint8Array([0]),
    new Uint8Array([CONTENT_MAGIC, CONTENT_VERSION, kindTag(kind)]),
    lenBytes,
    new Uint8Array([0]),
    bytes,
  ]);
}

/** Compute the content `Hash` of a `ContentObject` envelope. */
export async function contentObjectId(
  kind: ContentKind,
  bytes: Uint8Array,
): Promise<Hash> {
  return sha256(contentFraming(kind, bytes));
}

/** Create a `ContentObject` envelope of the given kind, computing its id. The
 *  returned `bytes` is an owned copy so callers cannot mutate the input after
 *  hashing. */
export async function createContentObject(
  kind: ContentKind,
  bytes: Uint8Array,
): Promise<ContentObject> {
  const owned = new Uint8Array(bytes);
  return { id: await contentObjectId(kind, owned), kind, bytes: owned };
}

/**
 * Serialize a `ContentObject` to self-describing bytes:
 * `content\0<magic(1)><version(1)><kindTag(1)><len>\0<bytes>\0<id-hex>`.
 * The id is carried for storage convenience and verified on parse.
 */
export function serializeContentObject(obj: ContentObject): Uint8Array {
  const framed = contentFraming(obj.kind, obj.bytes);
  const idHex = new TextEncoder().encode(obj.id);
  return concat([framed, new Uint8Array([0]), idHex]);
}

/**
 * Parse and verify a `ContentObject` from `serializeContentObject` output.
 * Async because it verifies the embedded id against the recomputed envelope
 * content hash.
 */
export async function parseContentObject(data: Uint8Array): Promise<ContentObject> {
  // Split off the trailing id-hex.
  let lastNul = -1;
  for (let i = data.length - 1; i >= 0; i--) {
    if (data[i] === 0) {
      lastNul = i;
      break;
    }
  }
  if (lastNul < 0) throw new Error("Invalid ContentObject serialization: missing id delimiter");
  const idHex = new TextDecoder().decode(data.subarray(lastNul + 1));
  if (!isHash(idHex)) throw new Error("Invalid ContentObject serialization: bad id hash");
  const head = data.subarray(0, lastNul); // `content\0<magic><ver><kind><len>\0<bytes>`

  const header = new TextEncoder().encode("content");
  if (head.length < header.length + 1 + 3) {
    throw new Error("Invalid ContentObject serialization: too short");
  }
  for (let i = 0; i < header.length; i++) {
    if (head[i] !== header[i]) {
      throw new Error("Invalid ContentObject serialization: bad magic header");
    }
  }
  if (head[header.length] !== 0) {
    throw new Error("Invalid ContentObject serialization: bad header delimiter");
  }
  const off = header.length + 1;
  if (head[off] !== CONTENT_MAGIC) throw new Error("Invalid ContentObject serialization: bad magic");
  if (head[off + 1] !== CONTENT_VERSION) {
    throw new Error(`Unsupported ContentObject version: ${head[off + 1]}`);
  }
  const kind = tagKind(head[off + 2]!);
  // Remaining: `<len>\0<bytes>`
  const rest = head.subarray(off + 3);
  // Find NUL terminating the length.
  let nul = -1;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === 0) {
      nul = i;
      break;
    }
  }
  if (nul < 0) throw new Error("Invalid ContentObject serialization: missing length delimiter");
  const lenStr = new TextDecoder().decode(rest.subarray(0, nul));
  let len: number;
  try {
    len = parseDecimalLen(lenStr);
  } catch {
    throw new Error(`Invalid ContentObject serialization: bad length "${lenStr}"`);
  }
  const bytes = rest.subarray(nul + 1);
  if (bytes.length !== len) {
    throw new Error(
      `Invalid ContentObject serialization: length mismatch (header=${len}, actual=${bytes.length})`,
    );
  }
  // Copy the payload before any await: `bytes` is a view into `rest`, which is
  // a view into the caller's `data`. The await below yields control back to the
  // caller, who could mutate `data` (and thus `bytes`) before the id is
  // recomputed. The owned copy is what gets hashed and returned, isolating the
  // object from post-parse mutation of the input buffer.
  const owned = new Uint8Array(bytes);
  const recomputed = await sha256(contentFraming(kind, owned));
  if (recomputed !== idHex) {
    throw new Error("Invalid ContentObject serialization: id does not match envelope hash");
  }
  return { id: asHash(idHex), kind, bytes: owned };
}

