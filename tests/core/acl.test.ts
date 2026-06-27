// C1 unit tests: AclRecord canonical serialization, the signed metadata-graph
// node (HMAC signature stub), and the SnapshotEnvelope storage contract.

import { describe, expect, it } from "bun:test";
import {
  type AclRecord,
  type Permission,
  canonicalAclRecord,
  createSignedAclNode,
  parseCanonicalAclRecord,
  parseSignedAclNode,
  serializeSignedAclNode,
  signAclRecord,
  verifyAclRecord,
} from "../../src/core/acl.ts";
import {
  asActorId,
  asHash,
  asSnapshotId,
  sha256,
} from "../../src/core/ids.ts";
import {
  parseSnapshotEnvelope,
  serializeSnapshotEnvelope,
} from "../../src/core/snapshot-contract.ts";
import { asAclNodeId } from "../../src/core/ids.ts";

const KEY = new TextEncoder().encode("local-stub-key-not-production");

function sampleRecord(perms: Permission[] = ["read", "write"]): AclRecord {
  return {
    subject: asActorId("actor-alice"),
    object: asHash("a".repeat(64)),
    permissions: new Set<Permission>(perms),
  };
}

describe("C1 AclRecord canonical framing", () => {
  it("canonical framing is deterministic for the same logical record", () => {
    const a = canonicalAclRecord(sampleRecord(["read", "write"]));
    const b = canonicalAclRecord(sampleRecord(["write", "read"])); // different insertion order
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("different permissions produce different framing", () => {
    const a = canonicalAclRecord(sampleRecord(["read"]));
    const b = canonicalAclRecord(sampleRecord(["read", "write"]));
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("round-trips through parse", () => {
    const record = sampleRecord(["read", "write", "publish"]);
    const parsed = parseCanonicalAclRecord(canonicalAclRecord(record));
    expect(parsed.subject).toBe(record.subject);
    expect(parsed.object).toBe(record.object);
    expect(parsed.permissions).toEqual(record.permissions);
  });

  it("parse rejects an invalid permission token", () => {
    // Corrupt the perms field by replacing the trailing `read\0` with `bogus\0`.
    const framed = canonicalAclRecord(sampleRecord(["read"]));
    const str = new TextDecoder().decode(framed);
    const tampered = new TextEncoder().encode(str.replace("read", "bogus"));
    expect(() => parseCanonicalAclRecord(tampered)).toThrow();
  });
});

describe("C1 signed ACL node (HMAC stub)", () => {
  it("signs and verifies a record under the correct key", async () => {
    const record = sampleRecord(["read", "publish"]);
    const sig = await signAclRecord(record, KEY);
    expect(sig.length).toBe(32);
    await expect(verifyAclRecord(record, sig, KEY)).resolves.toBe(true);
  });

  it("verification fails under a different key", async () => {
    const record = sampleRecord();
    const sig = await signAclRecord(record, KEY);
    const otherKey = new TextEncoder().encode("a-different-key");
    await expect(verifyAclRecord(record, sig, otherKey)).resolves.toBe(false);
  });

  it("verification fails when the record is tampered (signature does not match)", async () => {
    const record = sampleRecord(["read", "write"]);
    const sig = await signAclRecord(record, KEY);
    const tampered: AclRecord = {
      subject: record.subject,
      object: record.object,
      permissions: new Set<Permission>(["read"]), // dropped "write"
    };
    await expect(verifyAclRecord(tampered, sig, KEY)).resolves.toBe(false);
  });

  it("verification fails when the signature bytes are tampered", async () => {
    const record = sampleRecord();
    const sig = await signAclRecord(record, KEY);
    const tampered = sig.slice();
    tampered[0] = (tampered[0]! ^ 0xff) & 0xff;
    await expect(verifyAclRecord(record, tampered, KEY)).resolves.toBe(false);
  });

  it("createSignedAclNode produces an id that is the hash of record+signature", async () => {
    const record = sampleRecord(["read"]);
    const node = await createSignedAclNode(record, KEY);
    const expectedId = await sha256(
      new Uint8Array([...canonicalAclRecord(record), ...node.signature]),
    );
    expect(node.id).toBe(expectedId);
    expect(asAclNodeId(node.id)).toBe(node.id);
  });

  it("round-trips through serialize/parse with id, record, and signature intact", async () => {
    const record = sampleRecord(["read", "write", "publish"]);
    const node = await createSignedAclNode(record, KEY);
    const serialized = serializeSignedAclNode(node);
    const parsed = await parseSignedAclNode(serialized);
    expect(parsed.id).toBe(node.id);
    expect(parsed.record.subject).toBe(record.subject);
    expect(parsed.record.object).toBe(record.object);
    expect(parsed.record.permissions).toEqual(record.permissions);
    expect(Array.from(parsed.signature)).toEqual(Array.from(node.signature));
    // The parsed node still verifies against the key.
    await expect(verifyAclRecord(parsed.record, parsed.signature, KEY)).resolves.toBe(true);
  });

  it("parse rejects a tampered signature (id no longer matches record+signature)", async () => {
    const node = await createSignedAclNode(sampleRecord(["read"]), KEY);
    const serialized = serializeSignedAclNode(node);
    const tampered = serialized.slice();
    // Flip a byte inside the 32-byte signature region (before the 64-byte id-hex).
    const sigStart = tampered.length - 1 - 64 - 32;
    tampered[sigStart] = (tampered[sigStart]! ^ 0x01) & 0xff;
    await expect(parseSignedAclNode(tampered)).rejects.toThrow();
  });

  it("parse rejects a tampered id-hex", async () => {
    const node = await createSignedAclNode(sampleRecord(["read"]), KEY);
    const serialized = serializeSignedAclNode(node);
    const tampered = serialized.slice();
    const idx = tampered.length - 2; // inside trailing id-hex
    const v = tampered[idx]!;
    tampered[idx] = v === 0x61 ? 0x62 : 0x61;
    await expect(parseSignedAclNode(tampered)).rejects.toThrow();
  });

  it("parse rejects a non-canonical permission order (tamper)", async () => {
    // Reorder the perms field from canonical `read,write` to `write,read`.
    // This decodes to the same logical set, so a lenient parser that only
    // re-canonicalizes would accept it. The hardened parser authenticates the
    // record prefix byte-for-byte and must reject it.
    const node = await createSignedAclNode(sampleRecord(["read", "write"]), KEY);
    const serialized = serializeSignedAclNode(node);
    const str = new TextDecoder().decode(serialized);
    // The canonical perms substring is `read,write`; swap to `write,read`.
    const tamperedStr = str.replace("read,write", "write,read");
    const tampered = new TextEncoder().encode(tamperedStr);
    await expect(parseSignedAclNode(tampered)).rejects.toThrow();
  });

  it("parse rejects an extra byte inserted between record+signature and id", async () => {
    // Insert one byte after the 32-byte signature, before the 64-byte id-hex.
    // The canonical layout has no slack there; the hardened parser rejects any
    // trailing/extra bytes between record+signature and the id.
    const node = await createSignedAclNode(sampleRecord(["read"]), KEY);
    const serialized = serializeSignedAclNode(node);
    // Layout: <record><sig(32)><id-hex(64)><NUL>. Insert before id-hex.
    const sigEnd = serialized.length - 1 - 64;
    const tampered = new Uint8Array(serialized.length + 1);
    tampered.set(serialized.subarray(0, sigEnd), 0);
    tampered[sigEnd] = 0xff; // extra byte
    tampered.set(serialized.subarray(sigEnd), sigEnd + 1);
    await expect(parseSignedAclNode(tampered)).rejects.toThrow();
  });

  it("ACL metadata is separate from content addressing (record framing is not a blob framing)", async () => {
    // The canonical ACL framing must not collide with blob framing: hashing the
    // same bytes through the blob framing vs the acl framing yields different
    // hashes, confirming the two graphs are structurally separate.
    const record = sampleRecord();
    const aclFraming = canonicalAclRecord(record);
    const blobHash = await sha256(
      new TextEncoder().encode(`blob ${aclFraming.length}\0`).length
        ? new Uint8Array([
            ...new TextEncoder().encode(`blob ${aclFraming.length}\0`),
            ...aclFraming,
          ])
        : aclFraming,
    );
    const aclHash = await sha256(aclFraming);
    expect(blobHash).not.toBe(aclHash);
  });
});

describe("C1 ACL boundary hardening", () => {
  it("asActorId rejects NUL delimiters in actor ids", () => {
    expect(() => asActorId("alice\0admin")).toThrow();
    expect(() => asActorId("alice")).not.toThrow();
  });

  it("asActorId rejects an actor id that is only a NUL", () => {
    expect(() => asActorId("\0")).toThrow();
  });

  it("parseCanonicalAclRecord rejects a subject containing an embedded NUL", () => {
    // Build framing with a NUL inside the subject field: the strict parser must
    // treat the first NUL as the field delimiter and reject the resulting
    // short/empty subject rather than reassembling a forged cross-field subject.
    const framed = canonicalAclRecord(sampleRecord(["read"]));
    const str = new TextDecoder().decode(framed);
    // The canonical subject is "actor-alice"; inject a NUL into it so the
    // subject field is split early and the object field shifts.
    const tampered = new TextEncoder().encode(str.replace("actor-alice", "actor\0alice"));
    expect(() => parseCanonicalAclRecord(tampered)).toThrow();
  });

  it("parseCanonicalAclRecord rejects trailing bytes after the record", () => {
    const framed = canonicalAclRecord(sampleRecord(["read", "write"]));
    const withGarbage = new Uint8Array(framed.length + 2);
    withGarbage.set(framed, 0);
    withGarbage[framed.length] = 0x7a; // 'z'
    withGarbage[framed.length + 1] = 0x00;
    expect(() => parseCanonicalAclRecord(withGarbage)).toThrow();
  });

  it("parseCanonicalAclRecord rejects a non-canonical permission ordering", () => {
    // Canonical order is `publish,read,write` filtered to the present set, so
    // `read,write` is canonical but `write,read` is not. The strict parser must
    // reject the non-canonical ordering even though it decodes to the same set.
    const framed = canonicalAclRecord(sampleRecord(["read", "write"]));
    const str = new TextDecoder().decode(framed);
    const tampered = new TextEncoder().encode(str.replace("read,write", "write,read"));
    expect(() => parseCanonicalAclRecord(tampered)).toThrow();
  });

  it("parseCanonicalAclRecord rejects duplicate permission tokens", () => {
    // `read,read` decodes to a one-element set but is not canonical encoding.
    const framed = canonicalAclRecord(sampleRecord(["read"]));
    const str = new TextDecoder().decode(framed);
    const tampered = new TextEncoder().encode(str.replace("read", "read,read"));
    expect(() => parseCanonicalAclRecord(tampered)).toThrow();
  });

  it("parseCanonicalAclRecord rejects non-canonical subject bytes (malformed UTF-8)", () => {
    // TextDecoder maps malformed UTF-8 (e.g. a lone 0xff continuation byte) to
    // U+FFFD instead of throwing. A naive parser that only re-encodes the
    // decoded subject would accept 0xff and silently canonicalize it to the
    // 3-byte U+FFFD sequence, producing a record whose canonical framing
    // differs from the input. The hardened parser byte-compares the input to
    // the canonical re-serialization and must reject the non-canonical bytes.
    const framed = canonicalAclRecord(sampleRecord(["read"]));
    // The canonical subject is "actor-alice". Replace its first byte ('a' =
    // 0x61) with a lone 0xff byte, which is invalid UTF-8. The field is still
    // NUL-delimited (0xff != 0x00), so the prefix parser splits fields
    // correctly, but the subject bytes are non-canonical.
    const tampered = framed.slice();
    const subjectStart = new TextEncoder().encode("acl\0").length + 2; // past magic+version
    tampered[subjectStart] = 0xff;
    expect(() => parseCanonicalAclRecord(tampered)).toThrow();
  });

  it("parseCanonicalAclRecord rejects an overlong UTF-8 subject encoding", () => {
    // 'A' (U+0041) canonically encodes as the single byte 0x41. Its overlong
    // 2-byte form 0xc1 0xa1 also decodes to 'A' under a lenient decoder, but
    // re-encoding 'A' yields 0x41, not 0xc1 0xa1 — so the byte-comparison
    // rejects the non-canonical encoding. (UTF-8 decoders reject overlong
    // forms, but we assert the parser's byte-exact check independently.)
    const framed = canonicalAclRecord(sampleRecord(["read"]));
    const tampered = new Uint8Array(framed.length + 1);
    const subjectStart = new TextEncoder().encode("acl\0").length + 2;
    // Replace the leading 'a' (0x61) of "actor-alice" with overlong 0xc1 0xa1.
    tampered.set(framed.subarray(0, subjectStart), 0);
    tampered[subjectStart] = 0xc1;
    tampered[subjectStart + 1] = 0xa1;
    tampered.set(framed.subarray(subjectStart + 1), subjectStart + 2);
    expect(() => parseCanonicalAclRecord(tampered)).toThrow();
  });

  it("parseSignedAclNode rejects canonicalRecord + garbage before signature", async () => {
    const node = await createSignedAclNode(sampleRecord(["read"]), KEY);
    const serialized = serializeSignedAclNode(node);
    // Insert one garbage byte right after the canonical record framing, before
    // the 32-byte signature. The strict prefix parser + body-length check must
    // reject it.
    const recordFraming = canonicalAclRecord(node.record);
    const recLen = recordFraming.length;
    const tampered = new Uint8Array(serialized.length + 1);
    tampered.set(serialized.subarray(0, recLen), 0);
    tampered[recLen] = 0xff; // garbage between record and signature
    tampered.set(serialized.subarray(recLen), recLen + 1);
    await expect(parseSignedAclNode(tampered)).rejects.toThrow();
  });

  it("createSignedAclNode does not retain the caller's mutable permissions set", async () => {
    const perms = new Set<Permission>(["read", "write"]);
    const record: AclRecord = {
      subject: asActorId("actor-bob"),
      object: asHash("b".repeat(64)),
      permissions: perms,
    };
    const node = await createSignedAclNode(record, KEY);
    // Snapshot the canonical framing and signature before mutation.
    const framingBefore = canonicalAclRecord(node.record);
    const sigBefore = node.signature.slice();
    // Mutate the original caller-owned set after signing.
    perms.add("publish");
    perms.delete("read");
    // The node's record must be unaffected.
    expect(node.record.permissions).toEqual(new Set<Permission>(["read", "write"]));
    expect(Array.from(canonicalAclRecord(node.record))).toEqual(Array.from(framingBefore));
    expect(Array.from(node.signature)).toEqual(Array.from(sigBefore));
    // Serialization and verification remain valid against the original record.
    const serialized = serializeSignedAclNode(node);
    const reparsed = await parseSignedAclNode(serialized);
    expect(reparsed.record.permissions).toEqual(new Set<Permission>(["read", "write"]));
    await expect(verifyAclRecord(node.record, node.signature, KEY)).resolves.toBe(true);
  });

  it("parseSignedAclNode returns owned permissions isolated from later input mutation", async () => {
    const node = await createSignedAclNode(sampleRecord(["read", "publish"]), KEY);
    const serialized = serializeSignedAclNode(node);
    const parsed = await parseSignedAclNode(serialized);
    const permsBefore = new Set(parsed.record.permissions);
    // Mutating the parsed node's own set must not affect a re-serialization.
    (parsed.record.permissions as Set<Permission>).add("write");
    // Re-serializing the original node is still stable.
    const reserialized = serializeSignedAclNode(node);
    expect(Array.from(reserialized)).toEqual(Array.from(serialized));
    // The original parsed perms snapshot is unchanged for verification purposes.
    expect(permsBefore).toEqual(new Set<Permission>(["read", "publish"]));
  });
  it("parseSignedAclNode returns an owned signature isolated from later input mutation", async () => {
    const node = await createSignedAclNode(sampleRecord(["read"]), KEY);
    const serialized = serializeSignedAclNode(node);
    const parsed = await parseSignedAclNode(serialized);
    const sigBefore = parsed.signature.slice();
    const idBefore = parsed.id;
    // Zero out the entire input buffer after parsing. The parsed node's
    // signature and id are owned copies captured before/at parse time, so they
    // must be unaffected. This guards the async ownership boundary: the
    // signature is copied before the id-recomputation await, so a caller
    // mutating `serialized` after the parse resolves cannot corrupt the node.
    serialized.fill(0);
    expect(Array.from(parsed.signature)).toEqual(Array.from(sigBefore));
    expect(parsed.id).toBe(idBefore);
    // The parsed node still verifies against the key.
    await expect(verifyAclRecord(parsed.record, parsed.signature, KEY)).resolves.toBe(true);
  });

  it("createSignedAclNode id is consistent with the owned record and signature", async () => {
    // The node id is the hash of canonicalRecord(ownedRecord) || signature,
    // where ownedRecord is the snapshot taken before any await. Mutating the
    // caller's permissions set after the node resolves must not change the
    // relationship between id, record, and signature.
    const perms = new Set<Permission>(["read", "write"]);
    const record: AclRecord = {
      subject: asActorId("actor-carol"),
      object: asHash("c".repeat(64)),
      permissions: perms,
    };
    const node = await createSignedAclNode(record, KEY);
    const expectedId = await sha256(
      new Uint8Array([...canonicalAclRecord(node.record), ...node.signature]),
    );
    expect(node.id).toBe(expectedId);
    // Mutate the caller's set after resolution; the id must remain consistent
    // with the owned record (i.e. the owned record was used for both the
    // signature and the id, not the mutated caller set).
    perms.add("publish");
    const expectedIdAfter = await sha256(
      new Uint8Array([...canonicalAclRecord(node.record), ...node.signature]),
    );
    expect(node.id).toBe(expectedIdAfter);
  });
});

describe("C1 SnapshotEnvelope storage contract", () => {
  it("round-trips a root envelope (parentId null)", () => {
    const id = asSnapshotId("f".repeat(64));
    const env = {
      id,
      parentId: null,
      serializedBytes: new TextEncoder().encode("core snapshot state"),
    };
    const parsed = parseSnapshotEnvelope(serializeSnapshotEnvelope(env));
    expect(parsed.id).toBe(id);
    expect(parsed.parentId).toBeNull();
    expect(new TextDecoder().decode(parsed.serializedBytes)).toBe("core snapshot state");
  });

  it("round-trips a non-root envelope (parentId present)", () => {
    const parentId = asSnapshotId("a".repeat(64));
    const id = asSnapshotId("b".repeat(64));
    const env = {
      id,
      parentId,
      serializedBytes: new Uint8Array([1, 2, 3, 4, 5]),
    };
    const parsed = parseSnapshotEnvelope(serializeSnapshotEnvelope(env));
    expect(parsed.id).toBe(id);
    expect(parsed.parentId).toBe(parentId);
    expect(Array.from(parsed.serializedBytes)).toEqual([1, 2, 3, 4, 5]);
  });

  it("round-trips empty serializedBytes", () => {
    const env = {
      id: asSnapshotId("c".repeat(64)),
      parentId: null,
      serializedBytes: new Uint8Array(0),
    };
    const parsed = parseSnapshotEnvelope(serializeSnapshotEnvelope(env));
    expect(parsed.serializedBytes.length).toBe(0);
    expect(parsed.parentId).toBeNull();
  });

  it("preserves parentId exactly across round-trips", () => {
    const parentId = asSnapshotId("9".repeat(64));
    const env = {
      id: asSnapshotId("1".repeat(64)),
      parentId,
      serializedBytes: new TextEncoder().encode("x"),
    };
    const parsed = parseSnapshotEnvelope(serializeSnapshotEnvelope(env));
    expect(parsed.parentId).toBe(parentId);
  });

  it("parse rejects a tampered id", () => {
    const env = {
      id: asSnapshotId("d".repeat(64)),
      parentId: null,
      serializedBytes: new TextEncoder().encode("tamper-snap-id"),
    };
    const serialized = serializeSnapshotEnvelope(env);
    const tampered = serialized.slice();
    const idx = tampered.length - 2; // inside trailing id-hex
    // Flip to a non-hex character so the id is no longer a valid SHA-256 hex.
    tampered[idx] = 0x67; // 'g' is not a hex digit
    expect(() => parseSnapshotEnvelope(tampered)).toThrow();
  });

  it("parse rejects a truncated envelope", () => {
    const env = {
      id: asSnapshotId("e".repeat(64)),
      parentId: null,
      serializedBytes: new TextEncoder().encode("trunc-snap"),
    };
    const serialized = serializeSnapshotEnvelope(env);
    expect(() => parseSnapshotEnvelope(serialized.subarray(0, 4))).toThrow();
  });

  it("distinguishes root vs non-root via the parentId flag byte", () => {
    const root = {
      id: asSnapshotId("1".repeat(64)),
      parentId: null,
      serializedBytes: new Uint8Array(0),
    };
    const child = {
      id: asSnapshotId("2".repeat(64)),
      parentId: asSnapshotId("3".repeat(64)),
      serializedBytes: new Uint8Array(0),
    };
    const rootBytes = serializeSnapshotEnvelope(root);
    const childBytes = serializeSnapshotEnvelope(child);
    // The child serialization is longer by the 64-byte parentId hex.
    expect(childBytes.length).toBe(rootBytes.length + 64);
  });

  it("parse rejects a non-canonical length field (leading zero)", () => {
    // The canonical length is the plain decimal; "007" must be rejected even
    // though parseInt would accept it as 7. Build a valid envelope then splice
    // two '0' bytes into the length field.
    const env = {
      id: asSnapshotId("a".repeat(64)),
      parentId: null,
      serializedBytes: new TextEncoder().encode("payload"),
    };
    const serialized = serializeSnapshotEnvelope(env);
    // Locate the length field: the ASCII '7' immediately before the NUL that
    // precedes the payload. Insert two '0' bytes before it to get "007".
    const str = new TextDecoder().decode(serialized);
    const tamperedStr = str.replace("7\0payload", "007\0payload");
    const tampered = new TextEncoder().encode(tamperedStr);
    expect(() => parseSnapshotEnvelope(tampered)).toThrow();
  });

  it("parse returns owned serializedBytes (mutation of input is isolated)", () => {
    const env = {
      id: asSnapshotId("b".repeat(64)),
      parentId: null,
      serializedBytes: new TextEncoder().encode("owned-bytes"),
    };
    const serialized = serializeSnapshotEnvelope(env);
    const parsed = parseSnapshotEnvelope(serialized);
    // Mutate the original serialized buffer; the parsed copy must not change.
    const before = parsed.serializedBytes.slice();
    serialized.fill(0);
    expect(Array.from(parsed.serializedBytes)).toEqual(Array.from(before));
  });
});
