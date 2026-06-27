// C5 per-object encryption: AES-GCM encrypt/decrypt for secret blobs.
//
// Uses Web Crypto `subtle.encrypt`/`subtle.decrypt` with AES-GCM:
//   - 256-bit key (`src/crypto/keys.ts`)
//   - random 12-byte IV (`crypto.getRandomValues`) per encryption
//   - 16-byte auth tag (GCM default; persisted inside the framed bytes)
//
// `encryptSecret` produces self-describing framed ciphertext
//   `version(1) || algId(1) || iv(12) || ciphertext(N) || tag(16)`
// (framing defined in `src/core/secret-blob.ts`). Web Crypto's AES-GCM
// `encrypt` appends the 16-byte tag to the ciphertext, so the framed body is
// `iv || webCryptoOutput` where `webCryptoOutput = ciphertext(N) || tag(16)`.
//
// `decryptSecret` parses the framing, splits the trailing 16-byte tag, and
// verifies the GCM auth tag. Any failure — wrong key, tampered tag, truncated
// framing — returns a typed `Denied` (no plaintext leaks). The key is also
// checked against the blob's `policyId` *before* the GCM operation, so an
// unauthorized key is rejected without invoking the cipher.
//
// Access policy is bound to the C1 signed ACL graph via `policyId`: the blob
// records the policy id of the key that encrypted it, and a decryptor must
// supply a key whose derived policy id matches. There is no user-editable
// config (plan §2 decision 4). Key rotation (C5 stub) mints a new key with a
// new policy id; old keys cannot decrypt new content.

import { type Hash } from "../core/ids.ts";
import {
  type SecretBlob,
  buildFraming,
  fromContentObject,
  parseFraming,
  toContentObject,
} from "../core/secret-blob.ts";
import type { ContentObject } from "../core/object.ts";
import { type AclNodeId, type LocalKey, type SignedAclNode, verifyAclRecord } from "../core/acl.ts";
import type { SecretKey } from "./keys.ts";
import type { Store } from "../store/store.ts";

/** IV length for AES-GCM (matches `secret-blob.ts` `IV_LEN`). */
const IV_LEN = 12;
/** GCM auth tag length in bytes (matches `secret-blob.ts` `TAG_LEN`). */
const TAG_LEN = 16;

/**
 * Typed error raised when decryption is denied. This is the *only* failure
 * mode for `decryptSecret` and the store-backed decrypt helpers: wrong key,
 * policy mismatch, tampered auth tag, truncated framing, unsupported
 * algorithm, and missing/invalid ACL read grant all surface as `Denied`. No
 * plaintext is ever returned on failure. The error carries no secret material.
 */
export class Denied extends Error {
  /** Coarse reason code (no secret data). */
  readonly reason:
    | "policy-mismatch"
    | "bad-framing"
    | "unsupported-alg"
    | "auth-failure"
    | "no-grant"
    | "bad-grant"
    | "wrong-object"
    | "no-read-permission";

  constructor(
    reason: Denied["reason"],
    message?: string,
  ) {
    super(message ?? `decryption denied: ${reason}`);
    this.name = "Denied";
    this.reason = reason;
  }
}

/**
 * Encrypt `plaintext` under `key`, producing a `SecretBlob` whose `ciphertext`
 * is self-describing framed bytes and whose `policyId` is the key's derived
 * policy id. The blob's `id` is the content hash of the `kind: 'secret-blob'`
 * `ContentObject` envelope, ready for `Store.putObject`.
 *
 * A fresh random 12-byte IV is drawn for each call, so two encryptions of the
 * same plaintext under the same key produce different IVs and different
 * ciphertexts.
 */
export async function encryptSecret(
  plaintext: Uint8Array,
  key: SecretKey,
): Promise<SecretBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  // Web Crypto AES-GCM returns ciphertext || tag(16).
  const webCryptoOutput = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key.cryptoKey, plaintext),
  );
  const ctLen = webCryptoOutput.length - TAG_LEN;
  if (ctLen < 0) {
    throw new Error("AES-GCM output shorter than auth tag");
  }
  const ciphertext = webCryptoOutput.subarray(0, ctLen);
  const tag = webCryptoOutput.subarray(ctLen);
  const framed = buildFraming(iv, ciphertext, tag);
  const { secret } = await toContentObject(framed, key.policyId);
  return secret;
}

/**
 * Decrypt `blob` using `key`, returning the plaintext. The key must be
 * authorized: its derived `policyId` must equal the blob's `policyId`, and the
 * GCM auth tag must verify. Any failure returns `Denied` (no plaintext).
 *
 * Only the stored framed bytes are used — the IV and tag are parsed from the
 * framing, with no out-of-band parameters.
 */
export async function decryptSecret(
  blob: SecretBlob,
  key: SecretKey,
): Promise<Uint8Array> {
  if (key.policyId !== blob.policyId) {
    throw new Denied("policy-mismatch");
  }
  let parsed;
  try {
    parsed = parseFraming(blob.ciphertext);
  } catch {
    throw new Denied("bad-framing");
  }
  // Reassemble ciphertext || tag for Web Crypto, which expects the tag appended.
  const webCryptoInput = new Uint8Array(parsed.ciphertext.length + TAG_LEN);
  webCryptoInput.set(parsed.ciphertext, 0);
  webCryptoInput.set(parsed.tag, parsed.ciphertext.length);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: parsed.iv },
      key.cryptoKey,
      webCryptoInput,
    );
    return new Uint8Array(plain);
  } catch {
    throw new Denied("auth-failure");
  }
}

/**
 * Encrypt `plaintext` and persist it through `store` as a `kind:
 * 'secret-blob'` `ContentObject`. Returns the stored `SecretBlob` (with the
 * envelope `id` and framed `ciphertext`). Convenience wrapper around
 * `encryptSecret` + `Store.putObject`.
 */
export async function putSecret(
  store: Store,
  plaintext: Uint8Array,
  key: SecretKey,
): Promise<SecretBlob> {
  const secret = await encryptSecret(plaintext, key);
  const { obj } = await toContentObject(secret.ciphertext, secret.policyId);
  store.putObject(obj);
  return secret;
}

/**
 * Load a `SecretBlob` from a stored `ContentObject`, normalizing any
 * malformed/truncated stored bytes to `Denied('bad-framing')` rather than
 * letting `fromContentObject`/`parseFraming` throw a generic `Error`. The
 * `policyId` is the key/policy binding (taken from the key, not from an
 * untrusted caller) — it does not by itself authorize access; the signed ACL
 * read grant does (see `decryptSecretFromStore`).
 *
 * Internal helper: not exported. The public store-backed decrypt paths
 * (`getAndDecryptSecret`, `decryptSecretFromStore`) require a verified signed
 * ACL read grant; this loader only parses bytes and must not be exposed as a
 * standalone decrypt entry point.
 *
 * A missing object surfaces as the store's `NotFound`, not `Denied`.
 */
function loadSecretFromStore(
  store: Store,
  id: Hash,
  policyId: Hash,
): SecretBlob {
  const obj: ContentObject = store.getObject(id);
  try {
    return fromContentObject(obj, policyId);
  } catch {
    throw new Denied("bad-framing");
  }
}

/**
 * Retrieve a secret blob from `store` by its envelope `id` and decrypt it with
 * `key`, authorized by a verified C1 signed ACL read grant. This is the
 * policy-bound store-backed decrypt path: the caller supplies a `grantId`
 * (the `AclNodeId` of a signed read grant) plus the `LocalKey` used to
 * sign/verify ACL nodes; the helper fetches the node via `Store.getAcl`,
 * verifies its signature via `verifyAclRecord`, and requires
 * `record.object === id` and `permissions.has('read')` before decrypting.
 *
 * The `policyId` (key/policy binding) is taken from `key.policyId` — it is not
 * accepted as arbitrary caller authority. The signed ACL read grant authorizes
 * access to the object; the policy id binds the key to the blob. A caller
 * cannot decrypt a stored secret by merely supplying a `policyId` and key.
 *
 * Failures surface as typed `Denied` (see `decryptSecretFromStore` for the
 * reason codes). This helper is a thin wrapper around `decryptSecretFromStore`.
 */
export async function getAndDecryptSecret(
  store: Store,
  id: Hash,
  key: SecretKey,
  grantId: AclNodeId,
  aclKey: LocalKey,
): Promise<Uint8Array> {
  return decryptSecretFromStore(store, id, key, grantId, aclKey);
}

/**
 * Retrieve and decrypt a secret blob from `store`, authorized by a verified C1
 * signed ACL read grant. This is the policy-bound decrypt path: the caller
 * supplies a `grantId` (the `AclNodeId` of a signed read grant) plus the
 * `LocalKey` used to sign/verify ACL nodes; the helper fetches the node via
 * `Store.getAcl`, verifies its signature via `verifyAclRecord`, and requires
 * `record.object === id` and `permissions.has('read')` before decrypting.
 *
 * The `policyId` (key/policy binding) is taken from `key.policyId` — it is not
 * accepted as arbitrary caller authority. The signed ACL read grant authorizes
 * access to the object; the policy id binds the key to the blob.
 *
 * Failures surface as typed `Denied`:
 *   - `no-grant`: the ACL node is not present in the store (`NotFound` is
 *     normalized).
 *   - `bad-grant`: the node's signature does not verify under `aclKey`.
 *   - `wrong-object`: `record.object !== id` (the grant is for a different
 *     object).
 *   - `no-read-permission`: `permissions` does not include `'read'`.
 *   - `bad-framing`: the stored secret bytes are malformed/truncated.
 *   - `policy-mismatch` / `auth-failure`: from `decryptSecret`.
 */
export async function decryptSecretFromStore(
  store: Store,
  id: Hash,
  key: SecretKey,
  grantId: AclNodeId,
  aclKey: LocalKey,
): Promise<Uint8Array> {
  let node: SignedAclNode;
  try {
    node = store.getAcl(grantId);
  } catch {
    throw new Denied("no-grant");
  }
  const ok = await verifyAclRecord(node.record, node.signature, aclKey);
  if (!ok) {
    throw new Denied("bad-grant");
  }
  if (node.record.object !== id) {
    throw new Denied("wrong-object");
  }
  if (!node.record.permissions.has("read")) {
    throw new Denied("no-read-permission");
  }
  const secret = loadSecretFromStore(store, id, key.policyId);
  return decryptSecret(secret, key);
}
