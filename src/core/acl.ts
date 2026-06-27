// C1 ACL metadata graph: signed access records layered over content objects.
//
// Per plan §2 decision 1, access control is an *overlay* over the
// content-addressed object graph — ACL bytes never enter the content hash, so
// dedup is preserved. Per decision 4, access policy is bound to
// signed/authenticated graph state, not to a user-editable config file.
//
// C1 ships a *signature stub*: an HMAC-SHA256 over the serialized ACL record
// using a local symmetric key. This is NOT production signing — real asymmetric
// signing / KMS is deferred (see checklist Blocker/Deferred). The stub is
// sufficient to demonstrate that the metadata graph is authenticated and that
// tampering is detectable: `verifyAclNode` fails on any byte change.

import {
  type AclNodeId,
  type ActorId,
  type ObjectId,
  asAclNodeId,
  concat,
  constantTimeEqual,
  isHash,
  sha256,
} from "./ids.ts";

/** A single permission in an ACL entry. */
export type Permission = "read" | "write" | "publish";

/** The set of permissions granted to a subject over an object. */
export type PermissionSet = ReadonlySet<Permission>;

/** Canonical string encoding of a `PermissionSet`, used for serialization. */
const PERMISSION_ORDER: readonly Permission[] = ["publish", "read", "write"];

function encodePermissions(perms: PermissionSet): string {
  return PERMISSION_ORDER.filter((p) => perms.has(p)).join(",");
}

function decodePermissions(s: string): PermissionSet {
  if (s.length === 0) return new Set<Permission>();
  const parts = s.split(",");
  const set = new Set<Permission>();
  for (const p of parts) {
    if (p !== "read" && p !== "write" && p !== "publish") {
      throw new Error(`Invalid permission token: "${p}"`);
    }
    set.add(p);
  }
  return set;
}

/**
 * An access-control record: subject actor → object → permission set.
 *
 * The `objectId` is a content `Hash` (the id of a `ContentObject`); the ACL
 * graph references content objects but does not modify their addressing. ACL
 * records are themselves content-addressed by their signed-node id (see
 * `SignedAclNode`).
 */
export interface AclRecord {
  /** Actor granted the permissions. */
  readonly subject: ActorId;
  /** Content object id the permissions apply to. */
  readonly object: ObjectId;
  /** Permissions granted to `subject` over `object`. */
  readonly permissions: PermissionSet;
}

/**
 * A signed metadata-graph node wrapping an `AclRecord`. The `signature` is an
 * HMAC-SHA256 tag (32 bytes) over the canonical serialized record bytes,
 * computed with a local symmetric key. The `id` is the SHA-256 of the
 * signed-node bytes (record framing + signature), so the metadata graph is
 * itself content-addressed and tamper-evident.
 *
 * The key is a stub: callers pass a `LocalKey` (opaque bytes). Real key
 * management is deferred.
 */
export interface SignedAclNode {
  /** Content hash of the signed node (record framing + signature). */
  readonly id: AclNodeId;
  /** The authenticated ACL record. */
  readonly record: AclRecord;
  /** HMAC-SHA256 tag (32 bytes) over the canonical record framing. */
  readonly signature: Uint8Array;
}

/** Opaque local symmetric key used by the HMAC signature stub. */
export type LocalKey = Uint8Array;

/** Magic byte prefix for the canonical ACL record framing. */
const ACL_MAGIC = 0x02;
/** Canonical record framing layout version. */
const ACL_VERSION = 1;

/**
 * Canonical framed bytes for an `AclRecord`:
 * `acl\0<magic(1)><version(1)><subject>\0<object-hex>\0<perms>\0`.
 *
 * Fields are NUL-delimited. The subject and object are text; permissions are a
 * canonical comma-joined string in fixed order (`publish,read,write` filtered
 * to the present set) so two records with the same logical content produce
 * identical framing. This is the bytes that get HMAC-signed and hashed.
 */
export function canonicalAclRecord(record: AclRecord): Uint8Array {
  const header = new TextEncoder().encode("acl");
  const subject = new TextEncoder().encode(record.subject);
  const object = new TextEncoder().encode(record.object);
  const perms = new TextEncoder().encode(encodePermissions(record.permissions));
  return concat([
    header,
    new Uint8Array([0]),
    new Uint8Array([ACL_MAGIC, ACL_VERSION]),
    subject,
    new Uint8Array([0]),
    object,
    new Uint8Array([0]),
    perms,
    new Uint8Array([0]),
  ]);
}

/**
 * Parse the canonical record framing from the *prefix* of `data` and return the
 * parsed record plus the byte offset one-past the trailing record NUL. Used
 * internally by `parseSignedAclNode`, which has signature bytes following the
 * record prefix; the exported `parseCanonicalAclRecord` is strict and rejects
 * any trailing bytes.
 *
 * Validation is byte-exact: the perms field must be in canonical order
 * (`publish,read,write` filtered to the present set) with no duplicates, and
 * the subject must not contain a NUL (guaranteed by NUL-delimited field
 * splitting, but re-checked defensively).
 */
function parseCanonicalAclRecordPrefix(data: Uint8Array): { record: AclRecord; end: number } {
  const header = new TextEncoder().encode("acl");
  if (data.length < header.length + 1 + 2) {
    throw new Error("Invalid ACL record framing: too short");
  }
  for (let i = 0; i < header.length; i++) {
    if (data[i] !== header[i]) {
      throw new Error("Invalid ACL record framing: bad header");
    }
  }
  if (data[header.length] !== 0) {
    throw new Error("Invalid ACL record framing: bad header delimiter");
  }
  const off = header.length + 1;
  if (data[off] !== ACL_MAGIC) throw new Error("Invalid ACL record framing: bad magic");
  if (data[off + 1] !== ACL_VERSION) {
    throw new Error(`Unsupported ACL record version: ${data[off + 1]}`);
  }
  let i = off + 2;
  // subject \0 object \0 perms \0
  const fields: string[] = [];
  for (let f = 0; f < 3; f++) {
    let nul = -1;
    for (let j = i; j < data.length; j++) {
      if (data[j] === 0) {
        nul = j;
        break;
      }
    }
    if (nul < 0) throw new Error("Invalid ACL record framing: missing field delimiter");
    fields.push(new TextDecoder().decode(data.subarray(i, nul)));
    i = nul + 1;
  }
  const [subject, object, perms] = fields as [string, string, string];
  if (subject.length === 0) throw new Error("Invalid ACL record framing: empty subject");
  if (subject.includes("\0")) {
    throw new Error("Invalid ACL record framing: subject contains NUL");
  }
  if (!isHash(object)) throw new Error("Invalid ACL record framing: bad object hash");
  const permissions = decodePermissions(perms);
  // Strict canonical ordering: the decoded perms must re-serialize to the same
  // string. This rejects non-canonical orderings (e.g. "write,read") and
  // duplicates (e.g. "read,read") that decode to an equivalent set.
  if (encodePermissions(permissions) !== perms) {
    throw new Error("Invalid ACL record framing: non-canonical permission encoding");
  }
  return {
    record: {
      subject: subject as ActorId,
      object: object as ObjectId,
      permissions,
    },
    end: i,
  };
}

/**
 * Strictly parse a canonical ACL record framing back into an `AclRecord`.
 * Rejects any trailing bytes after the third NUL-delimited field, non-canonical
 * permission orderings, and embedded NULs in the subject. Use
 * `parseSignedAclNode` for the signed-node envelope (which has signature bytes
 * following the record prefix).
 */
export function parseCanonicalAclRecord(data: Uint8Array): AclRecord {
  const { record, end } = parseCanonicalAclRecordPrefix(data);
  if (end !== data.length) {
    throw new Error(
      `Invalid ACL record framing: trailing bytes after record (expected ${end}, got ${data.length})`,
    );
  }
  // Byte-exact canonicalization: the input must equal the canonical
  // serialization of the parsed record. The prefix parser decodes fields with
  // TextDecoder, which silently maps malformed/non-canonical UTF-8 (e.g.
  // overlong encodings or lone continuation bytes) to U+FFFD. Re-encoding the
  // decoded subject would not reproduce such bytes, so a non-canonical subject
  // could parse to a record whose canonical framing differs from the input.
  // Comparing the input bytes to `canonicalAclRecord(record)` rejects any
  // non-canonical subject bytes (and any other byte-level non-canonicity the
  // field decoder would otherwise paper over).
  const canonical = canonicalAclRecord(record);
  if (canonical.length !== data.length) {
    throw new Error("Invalid ACL record framing: non-canonical bytes");
  }
  for (let i = 0; i < canonical.length; i++) {
    if (data[i] !== canonical[i]) {
      throw new Error("Invalid ACL record framing: non-canonical bytes");
    }
  }
  return record;
}

/**
 * Compute the HMAC-SHA256 signature stub over the canonical record framing.
 * Uses Web Crypto `subtle.importKey` + `sign`. The key is any non-empty byte
 * sequence (local stub; real KMS deferred).
 */
export async function signAclRecord(
  record: AclRecord,
  key: LocalKey,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const tag = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    canonicalAclRecord(record) as BufferSource,
  );
  return new Uint8Array(tag);
}

/**
 * Verify an HMAC-SHA256 signature over the canonical record framing in constant
 * time. Returns `true` iff the signature matches.
 */
export async function verifyAclRecord(
  record: AclRecord,
  signature: Uint8Array,
  key: LocalKey,
): Promise<boolean> {
  const expected = await signAclRecord(record, key);
  return constantTimeEqual(expected, signature);
}

/**
 * Build a signed ACL node: compute the signature over the record, then the node
 * id as the SHA-256 of `canonicalRecord || signature`.
 *
 * The returned node owns its record: `permissions` is cloned into a fresh
 * `Set` so a caller mutating the original set after signing cannot mutate the
 * node's record or invalidate its signature/serialization. The signature is
 * also copied.
 */
export async function createSignedAclNode(
  record: AclRecord,
  key: LocalKey,
): Promise<SignedAclNode> {
  // Own the record synchronously, before any await: a caller mutating the
  // original `permissions` set (or swapping the subject/object strings, which
  // are immutable but referenced by alias) between the awaits below could
  // otherwise produce a signature over one record and an id over another. The
  // owned record is what gets signed, hashed, and returned.
  const ownedRecord: AclRecord = {
    subject: record.subject,
    object: record.object,
    permissions: new Set<Permission>(record.permissions),
  };
  const signature = await signAclRecord(ownedRecord, key);
  const id = asAclNodeId(
    await sha256(concat([canonicalAclRecord(ownedRecord), signature])),
  );
  return { id, record: ownedRecord, signature: signature.slice() };
}

/**
 * Serialize a `SignedAclNode` to self-describing bytes:
 * `<canonicalRecord><signature(32)><id-hex>\0`.
 * The canonical record framing is self-delimiting (it ends with a NUL after
 * perms), so the signature is the fixed 32 bytes immediately following, and the
 * node id hex follows that with a trailing NUL.
 */
export function serializeSignedAclNode(node: SignedAclNode): Uint8Array {
  if (node.signature.length !== 32) {
    throw new Error(`Invalid ACL signature length: ${node.signature.length}`);
  }
  const idHex = new TextEncoder().encode(node.id);
  return concat([canonicalAclRecord(node.record), node.signature, idHex, new Uint8Array([0])]);
}

/**
 * Parse a `SignedAclNode` from `serializeSignedAclNode` output and verify its
 * internal consistency. The canonical record prefix is authenticated
 * byte-for-byte: the parsed record is re-serialized and the leading bytes of
 * the body must equal that canonical serialization exactly, so non-canonical
 * equivalent records (e.g. permissions in a non-canonical order) are rejected.
 * No trailing/extra bytes are allowed between the record, the 32-byte
 * signature, and the id. The embedded id must equal the hash of
 * `canonicalRecord || signature`. Does NOT verify the signature against a key —
 * call `verifyAclRecord` for that. Returns the parsed node with owned copies.
 */
export async function parseSignedAclNode(data: Uint8Array): Promise<SignedAclNode> {
  // Layout: <canonicalRecord><signature(32)><id-hex(64)><NUL>.
  if (data.length === 0 || data[data.length - 1] !== 0) {
    throw new Error("Invalid SignedAclNode serialization: missing trailing delimiter");
  }
  if (data.length < 64 + 1 + 32) {
    throw new Error("Invalid SignedAclNode serialization: too short");
  }
  const idHex = new TextDecoder().decode(data.subarray(data.length - 1 - 64, data.length - 1));
  if (!isHash(idHex)) {
    throw new Error("Invalid SignedAclNode serialization: bad id hash");
  }
  const body = data.subarray(0, data.length - 1 - 64); // record+signature
  if (body.length < 32) {
    throw new Error("Invalid SignedAclNode serialization: body too short for signature");
  }
  // Parse the record from the canonical prefix (which may be followed by the
  // 32-byte signature), then authenticate the prefix byte-for-byte: the body
  // must begin with the canonical serialization of the parsed record. This
  // rejects non-canonical equivalent records (e.g. a perms field reordered to
  // "write,read") that would otherwise parse to the same logical record and
  // pass an id check. The prefix parser is strict about canonical ordering and
  // NUL-free subjects; the strict exported `parseCanonicalAclRecord` would
  // reject the trailing signature bytes, so we use the prefix parser here.
  const { record, end: recordEnd } = parseCanonicalAclRecordPrefix(body);
  const recordFraming = canonicalAclRecord(record);
  if (recordEnd !== recordFraming.length) {
    throw new Error("Invalid SignedAclNode: non-canonical record prefix");
  }
  for (let i = 0; i < recordFraming.length; i++) {
    if (body[i] !== recordFraming[i]) {
      throw new Error("Invalid SignedAclNode: non-canonical record prefix");
    }
  }
  // Reject any trailing/extra bytes between record+signature and the id.
  if (body.length !== recordFraming.length + 32) {
    throw new Error(
      `Invalid SignedAclNode: extra bytes after record+signature (expected ${recordFraming.length + 32}, got ${body.length})`,
    );
  }
  // Copy the signature before any await: `body` is a view into the caller's
  // `data`, and the await below yields control back to the caller, who could
  // mutate `data` (and thus `body`/`signature`) before the id is recomputed.
  // The owned copy is what gets hashed and returned, isolating the node from
  // post-parse mutation of the input buffer.
  const signature = body.subarray(recordFraming.length, recordFraming.length + 32).slice();
  const recomputedId = await sha256(concat([recordFraming, signature]));
  if (recomputedId !== idHex) {
    throw new Error("Invalid SignedAclNode: id does not match record+signature");
  }
  return { id: asAclNodeId(idHex), record, signature };
}
