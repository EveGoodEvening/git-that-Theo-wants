// C5 crypto key management: local key stub for AES-GCM.
//
// This is a **non-production** key stub (plan §2, C5 Blocker/Deferred): there is
// no KMS/HSM, no key escrow, and no asymmetric key wrapping. Keys are raw
// 256-bit symmetric material held in process memory. Real key management is
// deferred to a future chunk.
//
// A `SecretKey` bundles the raw key bytes with the Web Crypto `CryptoKey` and
// the derived `policyId` (see `policyIdForKey` in `secret-blob.ts`). The
// `policyId` binds the key to the signed ACL policy graph (C1): it is a
// deterministic hash of the key material, so the same key always yields the
// same policy id and a different key yields a different one. This lets
// `decryptSecret` reject an unauthorized key *before* the GCM tag check by
// comparing policy ids, and lets key rotation mint a fresh policy id under a
// fresh key.

import { type Hash, sha256 } from "../core/ids.ts";
import { policyIdForKey } from "../core/secret-blob.ts";

/** AES-GCM key length in bytes (256 bits). */
export const KEY_LEN = 32;

/**
 * A local AES-GCM secret key stub: raw bytes, the imported Web Crypto key, and
 * the derived `policyId` that binds it to the ACL policy graph.
 */
export interface SecretKey {
  /** Raw 32-byte key material (non-production local stub). */
  readonly raw: Uint8Array;
  /** Web Crypto `CryptoKey` for AES-GCM. */
  readonly cryptoKey: CryptoKey;
  /** Deterministic policy id derived from `raw` (binds to ACL graph). */
  readonly policyId: Hash;
}

/**
 * Import raw key bytes as a Web Crypto AES-GCM `CryptoKey` and derive its
 * `policyId`. The key bytes must be exactly `KEY_LEN` (32) bytes. The returned
 * `raw` is an owned copy so the caller cannot mutate the key after import.
 */
export async function importSecretKey(raw: Uint8Array): Promise<SecretKey> {
  if (raw.length !== KEY_LEN) {
    throw new Error(`Invalid secret key length: ${raw.length} != ${KEY_LEN}`);
  }
  // `new Uint8Array(raw)` always allocates a fresh ArrayBuffer and copies
  // element-by-element. `raw.slice()` would share memory when `raw` is a
  // Node `Buffer` (Buffer.prototype.slice overrides Uint8Array.prototype.slice
  // and returns a view into the same buffer), letting a caller mutate the
  // key's `raw` after import. Do this before any await so a caller mutating
  // `raw` during the await cannot race the copy.
  const owned = new Uint8Array(raw);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    owned,
    { name: "AES-GCM", length: KEY_LEN * 8 },
    false,
    ["encrypt", "decrypt"],
  );
  const policyId = await policyIdForKey(owned);
  return { raw: owned, cryptoKey, policyId };
}

/**
 * Generate a fresh random 32-byte AES-GCM key. Uses `crypto.getRandomValues`
 * (Web Crypto CSPRNG). The new key has a new `policyId`, which is the key
 * rotation mechanism (C5): new content encrypted under the new key carries the
 * new `policyId`, and the old key cannot decrypt it (different policy id +
 * GCM tag mismatch).
 */
export async function generateSecretKey(): Promise<SecretKey> {
  const raw = crypto.getRandomValues(new Uint8Array(KEY_LEN));
  return importSecretKey(raw);
}

/**
 * Key rotation stub: generate a fresh key with a fresh `policyId` for new
 * content. The old key remains valid only for decrypting content encrypted
 * under its own policy id; it cannot decrypt new content. Real rotation
 * (re-encrypting existing blobs, key wrapping, escrow) is deferred.
 *
 * This is a thin alias for `generateSecretKey` named to make the rotation
 * intent explicit at call sites.
 */
export async function rotateKey(): Promise<SecretKey> {
  return generateSecretKey();
}

/**
 * Fingerprint a key by hashing its raw bytes. Used for diagnostics and tests
 * to assert two keys are distinct without exposing the raw material.
 */
export async function keyFingerprint(key: SecretKey): Promise<Hash> {
  return sha256(key.raw);
}
