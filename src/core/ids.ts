// C1 core identifiers: Hash helpers and opaque id aliases.
//
// A `Hash` is a branded, lowercase hex string of SHA-256 output (64 chars).
// Branding keeps content hashes, snapshot ids, and acl node ids structurally
// distinct so they cannot be accidentally mixed at the type level, even though
// they share the same underlying representation.
//
// C1 owns the framing/hash primitives used by the object model. The hash is a
// deterministic SHA-256 over framed bytes; framing makes the hash unambiguous
// (e.g. `blob <len>\0<bytes>`) so that distinct logical objects cannot collide
// by sharing a byte prefix.

const HEX_LEN = 64; // SHA-256 = 32 bytes = 64 hex chars

/** Brand for a raw content/object hash (SHA-256 hex). */
export type Hash = string & { readonly __brand: "Hash" };

/**
 * Opaque alias for a snapshot's private content-addressed identity.
 *
 * C1 only *stores* snapshot ids opaquely; C4 computes a `SnapshotId` from the
 * snapshot's core state (parentId, canonical tree entries, timestamp, message,
 * immutable flag) per plan §2 decision 10. A `SnapshotId` is structurally a
 * `Hash` but branded separately so a snapshot id is never confused with a bare
 * blob/object hash at the type level.
 */
export type SnapshotId = string & { readonly __brand: "SnapshotId" };

/** Brand for an ACL metadata-graph node id (hash of the signed node bytes). */
export type AclNodeId = string & { readonly __brand: "AclNodeId" };

/** Brand for an actor id (opaque string assigned by the caller; not hashed here). */
export type ActorId = string & { readonly __brand: "ActorId" };

/** Brand for an object id referenced by ACL (a content `Hash`). */
export type ObjectId = Hash;

/** Assert a string is a valid lowercase hex SHA-256 and brand it as `Hash`. */
export function asHash(hex: string): Hash {
  if (hex.length !== HEX_LEN || !/^[0-9a-f]+$/.test(hex)) {
    throw new TypeError(`Invalid SHA-256 hex hash: ${hex}`);
  }
  return hex as Hash;
}

/** Brand a valid hex string as a `SnapshotId`. */
export function asSnapshotId(hex: string): SnapshotId {
  if (hex.length !== HEX_LEN || !/^[0-9a-f]+$/.test(hex)) {
    throw new TypeError(`Invalid SnapshotId (expected SHA-256 hex): ${hex}`);
  }
  return hex as SnapshotId;
}

/** Brand a valid hex string as an `AclNodeId`. */
export function asAclNodeId(hex: string): AclNodeId {
  if (hex.length !== HEX_LEN || !/^[0-9a-f]+$/.test(hex)) {
    throw new TypeError(`Invalid AclNodeId (expected SHA-256 hex): ${hex}`);
  }
  return hex as AclNodeId;
}

/** Brand an arbitrary non-empty string as an `ActorId`.
 *
 * NUL (`\0`) is forbidden because ACL records use NUL-delimited fields; an
 * embedded NUL would let a subject span into the next field and forge records.
 * The same rule is enforced by the canonical ACL parser on parsed subjects. */
export function asActorId(s: string): ActorId {
  if (s.length === 0) {
    throw new TypeError("ActorId must be a non-empty string");
  }
  if (s.includes("\0")) {
    throw new TypeError("ActorId must not contain NUL delimiters");
  }
  return s as ActorId;
}

/** Type guard: true if `h` is a 64-char lowercase hex string. */
export function isHash(h: unknown): h is Hash {
  return typeof h === "string" && h.length === HEX_LEN && /^[0-9a-f]+$/.test(h);
}

/**
 * Compute a deterministic SHA-256 hash over `bytes` and return it branded as
 * `Hash`. Uses the Web Crypto subtle digest (available in Bun/Node/browser).
 */
export async function sha256(bytes: Uint8Array): Promise<Hash> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return asHash(toHex(new Uint8Array(digest)));
}

/** Encode `bytes` as a lowercase hex string (no `0x` prefix). */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

/** Decode a lowercase hex string into a fresh `Uint8Array`. */
export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    throw new TypeError(`Invalid hex string: ${hex}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Framing helper: encode a UTF-8 string field as `<tag>\0<utf8 bytes>`.
 * Used by ACL/object serialization to delimit variable-length string fields
 * unambiguously. The NUL byte cannot appear in UTF-8 text, so the framing is
 * unambiguous.
 */
export function frameString(tag: string, value: string): Uint8Array {
  const tagBytes = new TextEncoder().encode(tag);
  const valBytes = new TextEncoder().encode(value);
  return concat([tagBytes, new Uint8Array([0]), valBytes]);
}

/**
 * Framing helper: encode a byte field as `<tag> <len>\0<bytes>` where `len` is
 * a decimal ASCII length. This is the framing used for blob content hashing
 * (`blob <len>\0<bytes>`) and for byte fields in serialized envelopes.
 */
export function frameBytes(tag: string, bytes: Uint8Array): Uint8Array {
  const tagBytes = new TextEncoder().encode(`${tag} ${bytes.length}`);
  return concat([tagBytes, new Uint8Array([0]), bytes]);
}

/**
 * Parse a canonical decimal ASCII length field: the string must consist of
 * decimal digits only (no sign, whitespace, leading zeros beyond a single "0",
 * or trailing characters) and represent a safe non-negative integer. Returns
 * the length, or throws on any non-canonical encoding. Used by object/snapshot
 * framing so that ambiguous length encodings (e.g. "007", "+5", "5\0x") are
 * rejected rather than silently accepted by a lenient `parseInt`.
 */
export function parseDecimalLen(s: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(s)) {
    throw new TypeError(`Invalid non-canonical length field: "${s}"`);
  }
  const n = Number(s);
  if (!Number.isSafeInteger(n)) {
    throw new TypeError(`Length field out of safe integer range: "${s}"`);
  }
  return n;
}

/** Concatenate an array of `Uint8Array` chunks into one fresh buffer. */
export function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Constant-time equality check for two byte arrays. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}
