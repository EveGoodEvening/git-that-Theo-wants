// C5 unit tests: per-object encryption at rest (AES-GCM secret blobs).
//
// Covers the checklist C5 test matrix:
//   - encryptSecret -> ciphertext contains no plaintext substring
//   - Store.putObject/getObject round-trips the framed ciphertext verbatim
//   - decryptSecret with authorized key -> plaintext
//   - unauthorized key -> typed `Denied`, no plaintext
//   - rotate key -> old key cannot decrypt new content
//   - framing parses recorded version/alg/iv/tag
//   - decryptSecret succeeds using only getObject bytes (no out-of-band IV)
//   - two encryptions of same plaintext under same key -> different iv/ciphertext
//   - tampered tag byte -> `Denied` (auth-tag integrity)
//   - key-rotation denial survives store round-trip
//
// Low-level crypto + store only: no commit/snapshot (C5 does not require
// C3/C4).

import { describe, expect, it } from "bun:test";
import { MemoryStore } from "../../src/store/memory-store.ts";
import type { Store } from "../../src/store/store.ts";
import {
  ALG_AES_GCM_256,
  FRAMING_PREFIX_LEN,
  IV_LEN,
  SECRET_FRAMING_VERSION,
  TAG_LEN,
  fromContentObject,
  parseFraming,
  toContentObject,
} from "../../src/core/secret-blob.ts";
import { asAclNodeId, asActorId, asHash } from "../../src/core/ids.ts";
import { createSignedAclNode } from "../../src/core/acl.ts";
import { createContentObject } from "../../src/core/object.ts";
import {
  generateSecretKey,
  importSecretKey,
  keyFingerprint,
  rotateKey,
} from "../../src/crypto/keys.ts";
import {
  Denied,
  decryptSecret,
  decryptSecretFromStore,
  encryptSecret,
  getAndDecryptSecret,
  putSecret,
} from "../../src/crypto/secret.ts";
import { createReadGrant, verifyReadGrant } from "../../src/crypto/policy.ts";

const PLAINTEXT = new TextEncoder().encode("the eagle flies at midnight");
const PLAINTEXT_STR = "the eagle flies at midnight";

function makeStore(): Store {
  return new MemoryStore();
}

describe("C5 secret blob crypto", () => {
  const ACL_KEY = new Uint8Array(32).fill(7);
  const WRONG_ACL_KEY = new Uint8Array(32).fill(8);
  describe("encryptSecret / decryptSecret round-trip", () => {
    it("encrypts then decrypts to the original plaintext", async () => {
      const key = await generateSecretKey();
      const secret = await encryptSecret(PLAINTEXT, key);
      const plain = await decryptSecret(secret, key);
      expect(new TextDecoder().decode(plain)).toBe(PLAINTEXT_STR);
    });

    it("ciphertext framing contains no plaintext substring", async () => {
      const key = await generateSecretKey();
      const secret = await encryptSecret(PLAINTEXT, key);
      const framedStr = new TextDecoder().decode(secret.ciphertext);
      expect(framedStr).not.toContain(PLAINTEXT_STR);
      // Also check the inner ciphertext body alone.
      const parsed = parseFraming(secret.ciphertext);
      expect(new TextDecoder().decode(parsed.ciphertext)).not.toContain(PLAINTEXT_STR);
    });

    it("ciphertext is longer than plaintext (framing + tag overhead)", async () => {
      const key = await generateSecretKey();
      const secret = await encryptSecret(PLAINTEXT, key);
      // framing = 1 + 1 + 12 + N + 16, so overhead = 30 bytes over plaintext.
      expect(secret.ciphertext.length).toBe(PLAINTEXT.length + 30);
    });
  });

  describe("framing", () => {
    it("parses to the recorded version/alg/iv/tag", async () => {
      const key = await generateSecretKey();
      const secret = await encryptSecret(PLAINTEXT, key);
      const parsed = parseFraming(secret.ciphertext);
      expect(parsed.version).toBe(SECRET_FRAMING_VERSION);
      expect(parsed.algId).toBe(ALG_AES_GCM_256);
      expect(parsed.iv.length).toBe(IV_LEN);
      expect(parsed.tag.length).toBe(TAG_LEN);
      // iv is random (not all zeros) with overwhelming probability.
      const allZero = parsed.iv.every((b) => b === 0);
      expect(allZero).toBe(false);
    });

    it("rejects truncated framing", () => {
      const tooShort = new Uint8Array(IV_LEN); // 12 bytes, < MIN_FRAMED_LEN
      expect(() => parseFraming(tooShort)).toThrow();
    });

    it("rejects unsupported version", async () => {
      const key = await generateSecretKey();
      const secret = await encryptSecret(PLAINTEXT, key);
      const tampered = secret.ciphertext.slice();
      tampered[0] = 0x02; // unsupported version
      expect(() => parseFraming(tampered)).toThrow();
    });

    it("rejects unsupported algId", async () => {
      const key = await generateSecretKey();
      const secret = await encryptSecret(PLAINTEXT, key);
      const tampered = secret.ciphertext.slice();
      tampered[1] = 0xff; // unsupported alg
      expect(() => parseFraming(tampered)).toThrow();
    });
  });

  describe("random IV", () => {
    it("same plaintext + same key -> different iv and ciphertext", async () => {
      const key = await generateSecretKey();
      const a = await encryptSecret(PLAINTEXT, key);
      const b = await encryptSecret(PLAINTEXT, key);
      // Same policy id (same key).
      expect(a.policyId).toBe(b.policyId);
      // Different envelope ids (different IV -> different ciphertext).
      expect(a.id).not.toBe(b.id);
      const pa = parseFraming(a.ciphertext);
      const pb = parseFraming(b.ciphertext);
      expect(pa.iv).not.toEqual(pb.iv);
      expect(pa.ciphertext).not.toEqual(pb.ciphertext);
      // Both decrypt to the same plaintext.
      expect(new TextDecoder().decode(await decryptSecret(a, key))).toBe(PLAINTEXT_STR);
      expect(new TextDecoder().decode(await decryptSecret(b, key))).toBe(PLAINTEXT_STR);
    });
  });

  describe("unauthorized key", () => {
    it("returns typed Denied and no plaintext", async () => {
      const encKey = await generateSecretKey();
      const decKey = await generateSecretKey();
      expect(encKey.policyId).not.toBe(decKey.policyId);
      const secret = await encryptSecret(PLAINTEXT, encKey);
      try {
        await decryptSecret(secret, decKey);
        throw new Error("expected Denied");
      } catch (e) {
        expect(e).toBeInstanceOf(Denied);
        expect((e as Denied).reason).toBe("policy-mismatch");
      }
    });

    it("keys are distinct (different fingerprints)", async () => {
      const a = await generateSecretKey();
      const b = await generateSecretKey();
      expect(await keyFingerprint(a)).not.toBe(await keyFingerprint(b));
    });
  });

  describe("tampered auth tag", () => {
    it("returns Denied on a flipped tag byte", async () => {
      const key = await generateSecretKey();
      const secret = await encryptSecret(PLAINTEXT, key);
      const framed = secret.ciphertext.slice();
      // Flip a byte in the trailing 16-byte tag region.
      const tagStart = framed.length - TAG_LEN;
      framed[tagStart] ^= 0x01;
      const tampered: typeof secret = {
        id: secret.id,
        ciphertext: framed,
        policyId: secret.policyId,
      };
      try {
        await decryptSecret(tampered, key);
        throw new Error("expected Denied");
      } catch (e) {
        expect(e).toBeInstanceOf(Denied);
        expect((e as Denied).reason).toBe("auth-failure");
      }
    });

    it("returns Denied on a flipped ciphertext byte", async () => {
      const key = await generateSecretKey();
      const secret = await encryptSecret(PLAINTEXT, key);
      const framed = secret.ciphertext.slice();
      // Flip a byte in the ciphertext body (between prefix and tag).
      framed[IV_LEN + 2 + 1] ^= 0x01;
      const tampered: typeof secret = {
        id: secret.id,
        ciphertext: framed,
        policyId: secret.policyId,
      };
      try {
        await decryptSecret(tampered, key);
        throw new Error("expected Denied");
      } catch (e) {
        expect(e).toBeInstanceOf(Denied);
        expect((e as Denied).reason).toBe("auth-failure");
      }
    });
  });

  describe("store round-trip", () => {
    it("putObject/getObject returns the same framed ciphertext", async () => {
      const store = makeStore();
      const key = await generateSecretKey();
      const secret = await encryptSecret(PLAINTEXT, key);
      const { obj } = await toContentObject(secret.ciphertext, secret.policyId);
      store.putObject(obj);
      expect(store.hasObject(secret.id)).toBe(true);
      const got = store.getObject(secret.id);
      expect(got.kind).toBe("secret-blob");
      expect(got.id).toBe(secret.id);
      // Byte-for-byte equal framed ciphertext.
      expect(Array.from(got.bytes)).toEqual(Array.from(secret.ciphertext));
    });

    it("decrypts using only getObject bytes (no out-of-band IV)", async () => {
      const store = makeStore();
      const key = await generateSecretKey();
      const secret = await putSecret(store, PLAINTEXT, key);
      // Reconstruct purely from stored bytes + policy id from the ACL graph.
      const got = store.getObject(secret.id);
      const restored = fromContentObject(got, secret.policyId);
      const plain = await decryptSecret(restored, key);
      expect(new TextDecoder().decode(plain)).toBe(PLAINTEXT_STR);
    });

    it("getAndDecryptSecret decrypts from store with a valid read grant", async () => {
      const store = makeStore();
      const key = await generateSecretKey();
      const secret = await putSecret(store, PLAINTEXT, key);
      const grant = await createReadGrant(store, secret.id, asActorId("alice"), ACL_KEY);
      const plain = await getAndDecryptSecret(store, secret.id, key, grant.id, asActorId("alice"), ACL_KEY);
      expect(new TextDecoder().decode(plain)).toBe(PLAINTEXT_STR);
    });

    it("raw store bytes contain no plaintext substring", async () => {
      const store = makeStore();
      const key = await generateSecretKey();
      const secret = await putSecret(store, PLAINTEXT, key);
      const got = store.getObject(secret.id);
      const rawStr = new TextDecoder().decode(got.bytes);
      expect(rawStr).not.toContain(PLAINTEXT_STR);
    });
  });

  describe("key rotation", () => {
    it("old key cannot decrypt new content after rotation", async () => {
      const oldKey = await generateSecretKey();
      const newKey = await rotateKey();
      expect(oldKey.policyId).not.toBe(newKey.policyId);
      // New content under the new key.
      const secret = await encryptSecret(PLAINTEXT, newKey);
      // Old key is denied (policy mismatch, before any GCM op).
      try {
        await decryptSecret(secret, oldKey);
        throw new Error("expected Denied");
      } catch (e) {
        expect(e).toBeInstanceOf(Denied);
        expect((e as Denied).reason).toBe("policy-mismatch");
      }
      // New key decrypts fine.
      expect(new TextDecoder().decode(await decryptSecret(secret, newKey))).toBe(PLAINTEXT_STR);
    });

    it("old key still decrypts old content", async () => {
      const oldKey = await generateSecretKey();
      const newKey = await rotateKey();
      const oldSecret = await encryptSecret(PLAINTEXT, oldKey);
      // Old key decrypts old content.
      expect(new TextDecoder().decode(await decryptSecret(oldSecret, oldKey))).toBe(PLAINTEXT_STR);
      // New key cannot decrypt old content.
      try {
        await decryptSecret(oldSecret, newKey);
        throw new Error("expected Denied");
      } catch (e) {
        expect(e).toBeInstanceOf(Denied);
        expect((e as Denied).reason).toBe("policy-mismatch");
      }
    });

    it("key-rotation denial survives store round-trip", async () => {
      const store = makeStore();
      const oldKey = await generateSecretKey();
      const newKey = await rotateKey();
      // Encrypt with new key, persist, retrieve, then try old key.
      const secret = await putSecret(store, PLAINTEXT, newKey);
      const got = store.getObject(secret.id);
      const restored = fromContentObject(got, secret.policyId);
      try {
        await decryptSecret(restored, oldKey);
        throw new Error("expected Denied");
      } catch (e) {
        expect(e).toBeInstanceOf(Denied);
        expect((e as Denied).reason).toBe("policy-mismatch");
      }
      // New key still decrypts the stored blob.
      const restoredNew = fromContentObject(store.getObject(secret.id), secret.policyId);
      expect(new TextDecoder().decode(await decryptSecret(restoredNew, newKey))).toBe(PLAINTEXT_STR);
    });
  });

  describe("importSecretKey", () => {
    it("imports a fixed raw key deterministically (same policyId)", async () => {
      const raw = new Uint8Array(32);
      for (let i = 0; i < raw.length; i++) raw[i] = i + 1;
      const a = await importSecretKey(raw);
      const b = await importSecretKey(raw);
      expect(a.policyId).toBe(b.policyId);
      // Round-trips through encrypt/decrypt.
      const secret = await encryptSecret(PLAINTEXT, a);
      expect(new TextDecoder().decode(await decryptSecret(secret, b))).toBe(PLAINTEXT_STR);
    });

    it("rejects a wrong-length key", async () => {
      const bad = new Uint8Array(16);
      try {
        await importSecretKey(bad);
        throw new Error("expected throw");
      } catch (e) {
        expect(String((e as Error).message)).toContain("Invalid secret key length");
      }
    });
  });

  // C5 policy binding: signed ACL read grant must authorize the object.
  describe("policy binding to signed ACL graph", () => {
    const SUBJECT = asActorId("alice");
    const BOB = asActorId("bob");

    it("valid signed read grant decrypts", async () => {
      const store = makeStore();
      const key = await generateSecretKey();
      const secret = await putSecret(store, PLAINTEXT, key);
      const grant = await createReadGrant(store, secret.id, SUBJECT, ACL_KEY);
      const plain = await decryptSecretFromStore(store, secret.id, key, grant.id, SUBJECT, ACL_KEY);
      expect(new TextDecoder().decode(plain)).toBe(PLAINTEXT_STR);
    });

    it("grant minted for Alice cannot be used by Bob even with grant id and object key", async () => {
      const store = makeStore();
      const key = await generateSecretKey();
      const secret = await putSecret(store, PLAINTEXT, key);
      const grant = await createReadGrant(store, secret.id, SUBJECT, ACL_KEY);
      try {
        await getAndDecryptSecret(store, secret.id, key, grant.id, BOB, ACL_KEY);
        throw new Error("expected Denied");
      } catch (e) {
        expect(e).toBeInstanceOf(Denied);
        expect((e as Denied).reason).toBe("wrong-subject");
      }
    });

    it("missing grant denies (no-grant)", async () => {
      const store = makeStore();
      const key = await generateSecretKey();
      const secret = await putSecret(store, PLAINTEXT, key);
      // A random 64-hex id that does not exist in the store.
      const bogusGrantId = asAclNodeId("0".repeat(64));
      try {
        await decryptSecretFromStore(store, secret.id, key, bogusGrantId, SUBJECT, ACL_KEY);
        throw new Error("expected Denied");
      } catch (e) {
        expect(e).toBeInstanceOf(Denied);
        expect((e as Denied).reason).toBe("no-grant");
      }
    });

    it("invalid signature denies (bad-grant)", async () => {
      const store = makeStore();
      const key = await generateSecretKey();
      const secret = await putSecret(store, PLAINTEXT, key);
      const grant = await createReadGrant(store, secret.id, SUBJECT, ACL_KEY);
      // Verify under a different ACL key -> signature mismatch.
      try {
        await decryptSecretFromStore(store, secret.id, key, grant.id, SUBJECT, WRONG_ACL_KEY);
        throw new Error("expected Denied");
      } catch (e) {
        expect(e).toBeInstanceOf(Denied);
        expect((e as Denied).reason).toBe("bad-grant");
      }
    });

    it("wrong object denies (wrong-object)", async () => {
      const store = makeStore();
      const key = await generateSecretKey();
      const secretA = await putSecret(store, PLAINTEXT, key);
      const secretB = await putSecret(store, new TextEncoder().encode("other"), key);
      // Grant for A, but request B's id.
      const grant = await createReadGrant(store, secretA.id, SUBJECT, ACL_KEY);
      try {
        await decryptSecretFromStore(store, secretB.id, key, grant.id, SUBJECT, ACL_KEY);
        throw new Error("expected Denied");
      } catch (e) {
        expect(e).toBeInstanceOf(Denied);
        expect((e as Denied).reason).toBe("wrong-object");
      }
    });

    it("no read permission denies (no-read-permission)", async () => {
      const store = makeStore();
      const key = await generateSecretKey();
      const secret = await putSecret(store, PLAINTEXT, key);
      // Mint a grant with write-only (no read) directly via createSignedAclNode.
      const node = await createSignedAclNode(
        {
          subject: SUBJECT,
          object: secret.id,
          permissions: new Set<"read" | "write" | "publish">(["write"]),
        },
        ACL_KEY,
      );
      store.putAcl(node);
      try {
        await decryptSecretFromStore(store, secret.id, key, node.id, SUBJECT, ACL_KEY);
        throw new Error("expected Denied");
      } catch (e) {
        expect(e).toBeInstanceOf(Denied);
        expect((e as Denied).reason).toBe("no-read-permission");
      }
    });

    it("verifyReadGrant returns undefined for missing/invalid/wrong-subject/wrong-object/no-read", async () => {
      const store = makeStore();
      const key = await generateSecretKey();
      const secret = await putSecret(store, PLAINTEXT, key);
      const grant = await createReadGrant(store, secret.id, SUBJECT, ACL_KEY);
      // Valid.
      const ok = await verifyReadGrant(store, grant.id, secret.id, SUBJECT, ACL_KEY);
      expect(ok?.id).toBe(grant.id);
      // Wrong ACL key.
      const bad = await verifyReadGrant(store, grant.id, secret.id, SUBJECT, WRONG_ACL_KEY);
      expect(bad).toBeUndefined();
      // Wrong subject.
      const wrongSubject = await verifyReadGrant(store, grant.id, secret.id, BOB, ACL_KEY);
      expect(wrongSubject).toBeUndefined();
      // Wrong object.
      const wrongObj = await verifyReadGrant(store, grant.id, asHash("1".repeat(64)), SUBJECT, ACL_KEY);
      expect(wrongObj).toBeUndefined();
      // Missing grant.
      const bogusGrantId = asAclNodeId("0".repeat(64));
      const missing = await verifyReadGrant(store, bogusGrantId, secret.id, SUBJECT, ACL_KEY);
      expect(missing).toBeUndefined();
    });
    it("getAndDecryptSecret denies without a grant (no-grant)", async () => {
      const store = makeStore();
      const key = await generateSecretKey();
      const secret = await putSecret(store, PLAINTEXT, key);
      const bogusGrantId = asAclNodeId("0".repeat(64));
      try {
        await getAndDecryptSecret(store, secret.id, key, bogusGrantId, SUBJECT, ACL_KEY);
        throw new Error("expected Denied");
      } catch (e) {
        expect(e).toBeInstanceOf(Denied);
        expect((e as Denied).reason).toBe("no-grant");
      }
    });

    it("getAndDecryptSecret denies with a wrong grant signature (bad-grant)", async () => {
      const store = makeStore();
      const key = await generateSecretKey();
      const secret = await putSecret(store, PLAINTEXT, key);
      const grant = await createReadGrant(store, secret.id, SUBJECT, ACL_KEY);
      try {
        await getAndDecryptSecret(store, secret.id, key, grant.id, SUBJECT, WRONG_ACL_KEY);
        throw new Error("expected Denied");
      } catch (e) {
        expect(e).toBeInstanceOf(Denied);
        expect((e as Denied).reason).toBe("bad-grant");
      }
    });

    it("getAndDecryptSecret denies when grant has no read permission (no-read-permission)", async () => {
      const store = makeStore();
      const key = await generateSecretKey();
      const secret = await putSecret(store, PLAINTEXT, key);
      const node = await createSignedAclNode(
        {
          subject: SUBJECT,
          object: secret.id,
          permissions: new Set<"read" | "write" | "publish">(["write"]),
        },
        ACL_KEY,
      );
      store.putAcl(node);
      try {
        await getAndDecryptSecret(store, secret.id, key, node.id, SUBJECT, ACL_KEY);
        throw new Error("expected Denied");
      } catch (e) {
        expect(e).toBeInstanceOf(Denied);
        expect((e as Denied).reason).toBe("no-read-permission");
      }
    });

    it("getAndDecryptSecret denies when grant is for a different object (wrong-object)", async () => {
      const store = makeStore();
      const key = await generateSecretKey();
      const secretA = await putSecret(store, PLAINTEXT, key);
      const secretB = await putSecret(store, new TextEncoder().encode("other"), key);
      const grant = await createReadGrant(store, secretA.id, SUBJECT, ACL_KEY);
      try {
        await getAndDecryptSecret(store, secretB.id, key, grant.id, SUBJECT, ACL_KEY);
        throw new Error("expected Denied");
      } catch (e) {
        expect(e).toBeInstanceOf(Denied);
        expect((e as Denied).reason).toBe("wrong-object");
      }
    });

    it("getAndDecryptSecret no longer accepts caller-supplied policyId as authority", async () => {
      // The old signature took (store, id, policyId, key) and would decrypt
      // with just the key. The new signature requires a verified grant; a
      // caller that knows only the id + key (and a bogus policyId) cannot
      // decrypt without a grant.
      const store = makeStore();
      const key = await generateSecretKey();
      const secret = await putSecret(store, PLAINTEXT, key);
      const bogusGrantId = asAclNodeId("0".repeat(64));
      try {
        // @ts-expect-error: legacy 4-arg signature is no longer supported
        await getAndDecryptSecret(store, secret.id, secret.policyId, key);
        throw new Error("expected Denied");
      } catch (e) {
        expect(e).toBeInstanceOf(Denied);
        expect((e as Denied).reason).toBe("no-grant");
      }
      // Sanity: a valid grant still decrypts.
      const grant = await createReadGrant(store, secret.id, SUBJECT, ACL_KEY);
      const plain = await getAndDecryptSecret(store, secret.id, key, grant.id, SUBJECT, ACL_KEY);
      expect(new TextDecoder().decode(plain)).toBe(PLAINTEXT_STR);
    });
  });

  // C5 malformed stored bytes normalize to Denied('bad-framing') even when a
  // valid signed ACL read grant authorizes the object — the grant authorizes
  // access, but malformed bytes still fail decryption.
  describe("malformed stored bytes", () => {
    const SUBJECT = asActorId("alice");
    const BOB = asActorId("bob");

    it("getAndDecryptSecret returns Denied('bad-framing') on truncated bytes with a valid grant", async () => {
      const store = makeStore();
      const key = await generateSecretKey();
      // A secret-blob envelope whose bytes are too short to be valid framing.
      const malformed = await toContentObject(new Uint8Array(5), key.policyId);
      store.putObject(malformed.obj);
      // Grant authorizes read of this (malformed) object.
      const grant = await createReadGrant(store, malformed.secret.id, SUBJECT, ACL_KEY);
      try {
        await getAndDecryptSecret(store, malformed.secret.id, key, grant.id, SUBJECT, ACL_KEY);
        throw new Error("expected Denied");
      } catch (e) {
        expect(e).toBeInstanceOf(Denied);
        expect((e as Denied).reason).toBe("bad-framing");
      }
    });

    it("decryptSecretFromStore checks subject before loading malformed bytes", async () => {
      const store = makeStore();
      const key = await generateSecretKey();
      const malformed = await toContentObject(new Uint8Array(5), key.policyId);
      store.putObject(malformed.obj);
      const grant = await createReadGrant(store, malformed.secret.id, SUBJECT, ACL_KEY);
      try {
        await decryptSecretFromStore(store, malformed.secret.id, key, grant.id, BOB, ACL_KEY);
        throw new Error("expected Denied");
      } catch (e) {
        expect(e).toBeInstanceOf(Denied);
        expect((e as Denied).reason).toBe("wrong-subject");
      }
    });

    it("decryptSecretFromStore returns Denied('bad-framing') on non-secret-blob kind with a valid grant", async () => {
      const store = makeStore();
      const key = await generateSecretKey();
      // A plain blob object, not a secret-blob.
      const plain = await createContentObject("blob", new Uint8Array(8));
      store.putObject(plain);
      const grant = await createReadGrant(store, plain.id, SUBJECT, ACL_KEY);
      try {
        await decryptSecretFromStore(store, plain.id, key, grant.id, SUBJECT, ACL_KEY);
        throw new Error("expected Denied");
      } catch (e) {
        expect(e).toBeInstanceOf(Denied);
        expect((e as Denied).reason).toBe("bad-framing");
      }
    });

    it("decryptSecretFromStore returns Denied('bad-framing') on truncated framing with a valid grant", async () => {
      const store = makeStore();
      const key = await generateSecretKey();
      // A secret-blob envelope whose bytes are too short to be valid framing.
      const tooShort = await createContentObject("secret-blob", new Uint8Array(4));
      store.putObject(tooShort);
      const grant = await createReadGrant(store, tooShort.id, SUBJECT, ACL_KEY);
      try {
        await decryptSecretFromStore(store, tooShort.id, key, grant.id, SUBJECT, ACL_KEY);
        throw new Error("expected Denied");
      } catch (e) {
        expect(e).toBeInstanceOf(Denied);
        expect((e as Denied).reason).toBe("bad-framing");
      }
    });
  });

  // C5 importSecretKey Buffer aliasing regression.
  describe("importSecretKey Buffer aliasing", () => {
    it("mutating caller buffer after import does not mutate SecretKey.raw", async () => {
      // Use a Buffer (Uint8Array subclass) to exercise the aliasing path.
      const raw = Buffer.alloc(32);
      for (let i = 0; i < raw.length; i++) raw[i] = i + 1;
      const key = await importSecretKey(raw);
      const fpBefore = await keyFingerprint(key);
      // Mutate the caller's buffer after import.
      raw[0] = 255;
      raw[31] = 128;
      // The key's raw must be unaffected.
      expect(key.raw[0]).toBe(1);
      expect(key.raw[31]).toBe(32);
      const fpAfter = await keyFingerprint(key);
      expect(fpAfter).toBe(fpBefore);
      // policyId is derived from raw and must be stable.
      const key2 = await importSecretKey(Buffer.from(raw));
      // key2 was imported from the now-mutated buffer, so its policyId differs
      // from the original key's policyId (proving the original key did not
      // pick up the mutation).
      expect(key2.policyId).not.toBe(key.policyId);
    });

    it("mutating caller Uint8Array after import does not mutate SecretKey.raw", async () => {
      const raw = new Uint8Array(32);
      for (let i = 0; i < raw.length; i++) raw[i] = i + 1;
      const key = await importSecretKey(raw);
      const fpBefore = await keyFingerprint(key);
      raw[0] = 255;
      expect(key.raw[0]).toBe(1);
      const fpAfter = await keyFingerprint(key);
      expect(fpAfter).toBe(fpBefore);
    });
  });

  // C5 SecretBlob bridge Buffer-backed byte ownership regression.
  // `Uint8Array.prototype.slice()` is virtual: on a Buffer (a Uint8Array
  // subclass) `Buffer.prototype.slice` overrides it to return a *shared-memory*
  // view, not a copy. The bridge must own caller bytes before hashing/returning
  // so a later mutation of the caller's Buffer cannot corrupt the SecretBlob's
  // ciphertext or invalidate its id.
  describe("SecretBlob bridge Buffer aliasing", () => {
    it("toContentObject owns Buffer ciphertext: later mutation does not change secret/obj bytes or id", async () => {
      // Build a valid framed ciphertext via encryptSecret, then re-wrap it
      // through toContentObject using a Buffer to exercise the aliasing path.
      const key = await generateSecretKey();
      const secret = await encryptSecret(PLAINTEXT, key);
      const buf = Buffer.from(secret.ciphertext);
      const originalBytes = new Uint8Array(buf); // snapshot of original content
      const { obj, secret: wrapped } = await toContentObject(buf, key.policyId);

      // Mutate the caller's Buffer after the call.
      buf[0] = buf[0]! ^ 0xff;
      buf[buf.length - 1] = buf[buf.length - 1]! ^ 0xff;

      // The wrapped SecretBlob ciphertext must still reflect the original bytes.
      expect(Array.from(wrapped.ciphertext)).toEqual(Array.from(originalBytes));
      // The ContentObject bytes must still reflect the original bytes.
      expect(Array.from(obj.bytes)).toEqual(Array.from(originalBytes));
      // The ids must remain consistent with the original bytes (unchanged).
      expect(wrapped.id).toBe(obj.id);
      // Re-wrapping the unmutated original must yield the same id, proving the
      // mutation did not leak into the hash input.
      const { obj: redo } = await toContentObject(originalBytes, key.policyId);
      expect(redo.id).toBe(obj.id);
    });

    it("fromContentObject owns Buffer bytes: later mutation does not change restored ciphertext", async () => {
      const key = await generateSecretKey();
      const secret = await encryptSecret(PLAINTEXT, key);
      const { obj } = await toContentObject(secret.ciphertext, key.policyId);
      // Simulate a store that hands back Buffer-backed bytes.
      const bufBytes = Buffer.from(obj.bytes);
      const originalBytes = new Uint8Array(bufBytes);
      const restored = fromContentObject(
        { id: obj.id, kind: obj.kind, bytes: bufBytes },
        key.policyId,
      );
      // Mutate the caller's Buffer after reconstruction.
      bufBytes[0] = bufBytes[0]! ^ 0xff;
      bufBytes[bufBytes.length - 1] = bufBytes[bufBytes.length - 1]! ^ 0xff;
      // Restored ciphertext must still reflect the original bytes.
      expect(Array.from(restored.ciphertext)).toEqual(Array.from(originalBytes));
      expect(restored.id).toBe(obj.id);
    });

    it("parseFraming owns Buffer bytes: later mutation does not change parsed iv/ciphertext/tag", async () => {
      const key = await generateSecretKey();
      const secret = await encryptSecret(PLAINTEXT, key);
      const buf = Buffer.from(secret.ciphertext);
      const original = parseFraming(buf);
      const ivCopy = new Uint8Array(original.iv);
      const ctCopy = new Uint8Array(original.ciphertext);
      const tagCopy = new Uint8Array(original.tag);
      // Mutate the caller's Buffer after parsing.
      buf[2] = buf[2]! ^ 0xff; // iv region
      buf[FRAMING_PREFIX_LEN] = buf[FRAMING_PREFIX_LEN]! ^ 0xff; // ciphertext body
      buf[buf.length - 1] = buf[buf.length - 1]! ^ 0xff; // tag region
      // Parsed views must still reflect the original bytes.
      expect(Array.from(original.iv)).toEqual(Array.from(ivCopy));
      expect(Array.from(original.ciphertext)).toEqual(Array.from(ctCopy));
      expect(Array.from(original.tag)).toEqual(Array.from(tagCopy));
    });
  });
});
