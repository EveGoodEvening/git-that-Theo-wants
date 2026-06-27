// C5 first-class secret blob: per-object encryption at rest.
//
// A `SecretBlob` is the content-graph view of an encrypted payload. Its
// `ciphertext` is *self-describing framed* bytes — the IV and GCM auth tag are
// persisted inside the bytes, so decryption needs no out-of-band parameters:
//
//   version(1) || algId(1) || iv(12) || ciphertext(N) || tag(16)
//
// The `id` is the content hash of the C1 `ContentObject` envelope with
// `kind: 'secret-blob'` (the envelope is defined in C1's `object.ts`; C5 only
// imports it — no C1 edits). `policyId` binds the blob to a signed ACL policy
// (C1 `SignedAclNode` graph): it is an opaque `Hash` identifying the key/policy
// that authorizes decryption. Per plan §2 decision 4, access policy is bound to
// signed/authenticated graph state, not to user-editable config, so `policyId`
// is set by the crypto layer from the key material and never edited by callers.
//
// The actual AES-GCM encrypt/decrypt lives in `src/crypto/secret.ts`; this
// module only defines the data shape, the framing, and the `ContentObject`
// envelope bridge so the store (C2) can persist secret blobs through the same
// crypto-agnostic seam it uses for plain blobs.

import {
  type Hash,
  concat,
  sha256,
} from "./ids.ts";
import {
  type ContentObject,
  createContentObject,
} from "./object.ts";

/**
 * Framing layout version for the self-describing `ciphertext` bytes.
 *
 *   version(1) || algId(1) || iv(12) || ciphertext(N) || tag(16)
 *
 * Bumping this changes the parser; `algId` selects the algorithm within a
 * version. Version 1 is the only supported value for now.
 */
export const SECRET_FRAMING_VERSION = 1;

/**
 * Algorithm id for AES-GCM with a 256-bit key, 12-byte IV, and 16-byte auth
 * tag. Stored as a single byte in the framing so future algorithms (e.g.
 * ChaCha20-Poly1305) can coexist without changing the version.
 */
export const ALG_AES_GCM_256 = 0x01;

/** IV length for AES-GCM (96 bits, the Web Crypto / NDA-recommended size). */
export const IV_LEN = 12;
/** GCM auth tag length in bytes (128 bits). */
export const TAG_LEN = 16;
/** Fixed prefix length: version + algId + iv. */
export const FRAMING_PREFIX_LEN = 1 + 1 + IV_LEN;
/** Minimum framed ciphertext length: prefix + zero-length ciphertext + tag. */
export const MIN_FRAMED_LEN = FRAMING_PREFIX_LEN + TAG_LEN;

/**
 * A first-class encrypted secret blob.
 *
 * - `id`: content hash of the `ContentObject` envelope (`kind: 'secret-blob'`,
 *   bytes = `ciphertext`). This is what the store indexes.
 * - `ciphertext`: self-describing framed bytes
 *   `version(1) || algId(1) || iv(12) || ciphertext(N) || tag(16)`. The IV and
 *   auth tag live inside these bytes; there is no external IV field.
 * - `policyId`: opaque `Hash` binding the blob to a signed ACL policy / key.
 *   Set by the crypto layer from key material; not user-editable.
 */
export interface SecretBlob {
  /** Content hash of the `kind: 'secret-blob'` envelope. */
  readonly id: Hash;
  /** Self-describing framed ciphertext (version+algId+iv+ct+tag). */
  readonly ciphertext: Uint8Array;
  /** Opaque id of the access policy / key that authorizes decryption. */
  readonly policyId: Hash;
}

/** Parsed view of the self-describing framing. */
export interface ParsedFraming {
  /** Framing version byte (currently `SECRET_FRAMING_VERSION`). */
  readonly version: number;
  /** Algorithm id byte (currently `ALG_AES_GCM_256`). */
  readonly algId: number;
  /** The 12-byte GCM initialization vector. */
  readonly iv: Uint8Array;
  /** The ciphertext body (excluding the trailing auth tag). */
  readonly ciphertext: Uint8Array;
  /** The 16-byte GCM authentication tag. */
  readonly tag: Uint8Array;
}

/**
 * Parse the self-describing framing
 * `version(1) || algId(1) || iv(12) || ciphertext(N) || tag(16)`.
 *
 * Returns owned copies of `iv`, `ciphertext`, and `tag` so the caller cannot
 * mutate the source buffer through the returned views. Throws on any framing
 * that is too short, has an unsupported version/algId, or whose length is
 * inconsistent.
 */
export function parseFraming(framed: Uint8Array): ParsedFraming {
  if (framed.length < MIN_FRAMED_LEN) {
    throw new Error(
      `Invalid secret framing: too short (${framed.length} < ${MIN_FRAMED_LEN})`,
    );
  }
  const version = framed[0]!;
  if (version !== SECRET_FRAMING_VERSION) {
    throw new Error(`Unsupported secret framing version: ${version}`);
  }
  const algId = framed[1]!;
  if (algId !== ALG_AES_GCM_256) {
    throw new Error(`Unsupported secret alg id: ${algId}`);
  }
  const iv = new Uint8Array(framed.subarray(2, 2 + IV_LEN));
  const bodyLen = framed.length - FRAMING_PREFIX_LEN - TAG_LEN;
  if (bodyLen < 0) {
    throw new Error("Invalid secret framing: body length negative");
  }
  const ciphertext = new Uint8Array(
    framed.subarray(FRAMING_PREFIX_LEN, FRAMING_PREFIX_LEN + bodyLen),
  );
  const tag = new Uint8Array(framed.subarray(FRAMING_PREFIX_LEN + bodyLen));
  if (tag.length !== TAG_LEN) {
    throw new Error(
      `Invalid secret framing: tag length ${tag.length} != ${TAG_LEN}`,
    );
  }
  return { version, algId, iv, ciphertext, tag };
}

/**
 * Assemble self-describing framing from its parts.
 *
 * `version` and `algId` are fixed to the current constants; `iv` must be
 * `IV_LEN` bytes, `tag` must be `TAG_LEN` bytes. The result is a fresh owned
 * buffer.
 */
export function buildFraming(
  iv: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
): Uint8Array {
  if (iv.length !== IV_LEN) {
    throw new Error(`Invalid iv length: ${iv.length} != ${IV_LEN}`);
  }
  if (tag.length !== TAG_LEN) {
    throw new Error(`Invalid tag length: ${tag.length} != ${TAG_LEN}`);
  }
  return concat([
    new Uint8Array([SECRET_FRAMING_VERSION, ALG_AES_GCM_256]),
    iv,
    ciphertext,
    tag,
  ]);
}

/**
 * Wrap framed `ciphertext` + `policyId` into a C1 `ContentObject` envelope with
 * `kind: 'secret-blob'`, computing the envelope content hash. The returned
 * `bytes` is the framed ciphertext (owned copy); the envelope `id` is what the
 * store indexes.
 */
export async function toContentObject(
  ciphertext: Uint8Array,
  policyId: Hash,
): Promise<{ obj: ContentObject; secret: SecretBlob }> {
  const owned = new Uint8Array(ciphertext);
  const obj = await createContentObject("secret-blob", owned);
  const secret: SecretBlob = {
    id: obj.id,
    ciphertext: owned,
    policyId,
  };
  return { obj, secret };
}

/**
 * Reconstruct a `SecretBlob` from a retrieved `ContentObject` envelope of kind
 * `'secret-blob'` plus the `policyId` recorded for it. The `ciphertext` is the
 * envelope `bytes` (framed). This does NOT decrypt — it only re-attaches the
 * policy binding. The store is crypto-agnostic and does not carry `policyId`,
 * so the policy id is supplied by the caller (who holds the ACL graph).
 *
 * Throws if the envelope is not a `secret-blob`.
 */
export function fromContentObject(
  obj: ContentObject,
  policyId: Hash,
): SecretBlob {
  if (obj.kind !== "secret-blob") {
    throw new Error(
      `fromContentObject requires kind 'secret-blob', got '${obj.kind}'`,
    );
  }
  // Validate framing eagerly so malformed stored bytes fail at load, not at
  // decrypt time. The returned ciphertext is an owned copy below.
  parseFraming(obj.bytes);
  return {
    id: obj.id,
    ciphertext: new Uint8Array(obj.bytes),
    policyId,
  };
}

/**
 * Deterministic `policyId` for a key: the SHA-256 of a domain-separated label
 * concatenated with the raw key bytes. This binds the policy id to the key
 * material so that (a) two different keys yield different policy ids and (b) a
 * decryptor can verify the supplied key matches the blob's `policyId` before
 * even attempting the GCM tag check.
 */
export async function policyIdForKey(keyBytes: Uint8Array): Promise<Hash> {
  const label = new TextEncoder().encode("gtw-secret-policy-v1\0");
  return sha256(concat([label, keyBytes]));
}

