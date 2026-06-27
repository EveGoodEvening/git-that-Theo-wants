// C1 unit tests: Blob content-addressing + round-trip, and the ContentObject
// envelope round-trip for both `blob` and `secret-blob` kinds.

import { describe, expect, it } from "bun:test";
import {
  type ContentObject,
  blobFraming,
  contentFraming,
  createBlob,
  createContentObject,
  parseBlob,
  parseContentObject,
  serializeBlob,
  serializeContentObject,
} from "../../src/core/object.ts";
import { asHash, sha256 } from "../../src/core/ids.ts";

describe("C1 Blob", () => {
  it("content hash is SHA-256 over `blob <len>\\0<bytes>` framing", async () => {
    const bytes = new TextEncoder().encode("hello world");
    const blob = await createBlob(bytes);
    const expected = await sha256(blobFraming(bytes));
    expect(blob.id).toBe(expected);
    expect(blob.id.length).toBe(64);
    expect(/^[0-9a-f]+$/.test(blob.id)).toBe(true);
  });

  it("identical content produces identical ids (content-addressing)", async () => {
    const a = await createBlob(new TextEncoder().encode("same content"));
    const b = await createBlob(new TextEncoder().encode("same content"));
    expect(a.id).toBe(b.id);
  });

  it("different content produces different ids", async () => {
    const a = await createBlob(new TextEncoder().encode("content A"));
    const b = await createBlob(new TextEncoder().encode("content B"));
    expect(a.id).not.toBe(b.id);
  });

  it("framing prevents prefix-collision between blobs of different sizes", async () => {
    // A blob whose bytes are the prefix of another must not share an id.
    const short = await createBlob(new TextEncoder().encode("ab"));
    const long = await createBlob(new TextEncoder().encode("abc"));
    expect(short.id).not.toBe(long.id);
  });

  it("round-trips through serialize/parse with id intact", async () => {
    const blob = await createBlob(new TextEncoder().encode("round-trip payload"));
    const serialized = serializeBlob(blob);
    const parsed = await parseBlob(serialized);
    expect(parsed.id).toBe(blob.id);
    expect(new TextDecoder().decode(parsed.bytes)).toBe("round-trip payload");
  });

  it("parse rejects a tampered id", async () => {
    const blob = await createBlob(new TextEncoder().encode("tamper-id"));
    const serialized = serializeBlob(blob);
    // Flip the last hex char of the embedded id.
    const tampered = serialized.slice();
    const last = tampered.length - 1;
    const lastChar = tampered[last]!;
    tampered[last] = lastChar === 0x30 /* '0' */ ? 0x31 : 0x30;
    await expect(parseBlob(tampered)).rejects.toThrow();
  });

  it("asHash brands the blob id", async () => {
    const blob = await createBlob(new TextEncoder().encode("brand me"));
    expect(asHash(blob.id)).toBe(blob.id);
  });

  it("createBlob returns owned bytes (input mutation is isolated)", async () => {
    const input = new TextEncoder().encode("owned-blob");
    const blob = await createBlob(input);
    const before = blob.bytes.slice();
    input.fill(0);
    expect(Array.from(blob.bytes)).toEqual(Array.from(before));
  });

  it("createBlob owns Buffer-backed input views before hashing", async () => {
    const backing = Buffer.from("Xcore-buffer-blobY");
    const input = backing.subarray(1, backing.length - 1);
    const original = new Uint8Array(input);
    const blob = await createBlob(input);
    const expectedId = await sha256(blobFraming(original));

    backing.fill(0);

    expect(Array.from(blob.bytes)).toEqual(Array.from(original));
    expect(blob.id).toBe(expectedId);
    expect(await sha256(blobFraming(blob.bytes))).toBe(blob.id);
  });

  it("parseBlob returns owned bytes (serialization mutation is isolated)", async () => {
    const blob = await createBlob(new TextEncoder().encode("owned-parse"));
    const serialized = serializeBlob(blob);
    const parsed = await parseBlob(serialized);
    const before = parsed.bytes.slice();
    serialized.fill(0);
    expect(Array.from(parsed.bytes)).toEqual(Array.from(before));
  });

  it("parseBlob id is consistent with the owned bytes copy", async () => {
    // The parse copies the payload before the verification await and hashes
    // the owned copy, so the parsed id must equal the hash of the parsed
    // bytes (not the input buffer, which a caller could mutate post-parse).
    const blob = await createBlob(new TextEncoder().encode("owned-id-check"));
    const serialized = serializeBlob(blob);
    const parsed = await parseBlob(serialized);
    // Mutate the input after parsing; the parsed id must still match the hash
    // of the parsed (owned) bytes.
    serialized.fill(0);
    const recomputed = await sha256(blobFraming(parsed.bytes));
    expect(parsed.id).toBe(recomputed);
  });

  it("parseBlob owns Buffer-backed serialized payload views before returning", async () => {
    const blob = await createBlob(new TextEncoder().encode("buffer-parse-blob"));
    const serialized = Buffer.from(serializeBlob(blob));
    const parsed = await parseBlob(serialized);
    const original = new Uint8Array(parsed.bytes);
    const expectedId = await sha256(blobFraming(original));

    serialized.fill(0);

    expect(Array.from(parsed.bytes)).toEqual(Array.from(original));
    expect(parsed.id).toBe(blob.id);
    expect(parsed.id).toBe(expectedId);
    expect(await sha256(blobFraming(parsed.bytes))).toBe(parsed.id);
  });

  it("parseBlob rejects a non-canonical length field (leading zero)", async () => {
    const blob = await createBlob(new TextEncoder().encode("len-canonical"));
    const serialized = serializeBlob(blob);
    // The blob framing is `blob <len>\0<bytes>`. Splice a '0' before the length
    // digit to produce a non-canonical "0<len>" length (e.g. "013").
    const str = new TextDecoder().decode(serialized);
    const tamperedStr = str.replace(/^blob (\d+)\0/, (_, d) => `blob 0${d}\0`);
    const tampered = new TextEncoder().encode(tamperedStr);
    await expect(parseBlob(tampered)).rejects.toThrow();
  });
});

describe("C1 ContentObject envelope", () => {
  it("creates a `blob` kind envelope with a content id", async () => {
    const payload = new TextEncoder().encode("plain payload");
    const obj = await createContentObject("blob", payload);
    expect(obj.kind).toBe("blob");
    expect(obj.id.length).toBe(64);
    expect(new TextDecoder().decode(obj.bytes)).toBe("plain payload");
  });

  it("creates a `secret-blob` kind envelope (envelope only, no crypto)", async () => {
    // C1 treats secret-blob as an opaque envelope; bytes are not interpreted.
    const opaqueCiphertext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const obj = await createContentObject("secret-blob", opaqueCiphertext);
    expect(obj.kind).toBe("secret-blob");
    expect(obj.id.length).toBe(64);
    expect(Array.from(obj.bytes)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("same payload, different kinds → different ids", async () => {
    const payload = new Uint8Array([9, 9, 9]);
    const plain = await createContentObject("blob", payload);
    const secret = await createContentObject("secret-blob", payload);
    expect(plain.id).not.toBe(secret.id);
  });

  it("round-trips a `blob` envelope through serialize/parse", async () => {
    const obj = await createContentObject("blob", new TextEncoder().encode("envelope rt blob"));
    const parsed = await parseContentObject(serializeContentObject(obj));
    expectContentEqual(parsed, obj);
  });

  it("round-trips a `secret-blob` envelope through serialize/parse", async () => {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
    const obj = await createContentObject("secret-blob", bytes);
    const parsed = await parseContentObject(serializeContentObject(obj));
    expectContentEqual(parsed, obj);
  });

  it("round-trips an empty-payload envelope", async () => {
    const obj = await createContentObject("blob", new Uint8Array(0));
    const parsed = await parseContentObject(serializeContentObject(obj));
    expectContentEqual(parsed, obj);
    expect(parsed.bytes.length).toBe(0);
  });

  it("parse rejects a truncated envelope", async () => {
    const obj = await createContentObject("blob", new TextEncoder().encode("trunc"));
    const serialized = serializeContentObject(obj);
    await expect(parseContentObject(serialized.subarray(0, 5))).rejects.toThrow();
  });

  it("parse rejects a tampered id", async () => {
    const obj = await createContentObject("blob", new TextEncoder().encode("tamper-co-id"));
    const serialized = serializeContentObject(obj);
    const tampered = serialized.slice();
    const idx = tampered.length - 2; // inside the 64-char id-hex
    const v = tampered[idx]!;
    tampered[idx] = v === 0x61 /* 'a' */ ? 0x62 : 0x61;
    await expect(parseContentObject(tampered)).rejects.toThrow();
  });

  it("createContentObject returns owned bytes (input mutation is isolated)", async () => {
    const input = new Uint8Array([10, 20, 30, 40]);
    const obj = await createContentObject("blob", input);
    const before = obj.bytes.slice();
    input.fill(0);
    expect(Array.from(obj.bytes)).toEqual(Array.from(before));
  });

  it("createContentObject owns Buffer-backed input views before hashing", async () => {
    const backing = Buffer.from("Xcore-buffer-contentY");
    const input = backing.subarray(1, backing.length - 1);
    const original = new Uint8Array(input);
    const obj = await createContentObject("blob", input);
    const expectedId = await sha256(contentFraming("blob", original));

    backing.fill(0);

    expect(Array.from(obj.bytes)).toEqual(Array.from(original));
    expect(obj.id).toBe(expectedId);
    expect(await sha256(contentFraming(obj.kind, obj.bytes))).toBe(obj.id);
  });

  it("parseContentObject returns owned bytes (serialization mutation is isolated)", async () => {
    const obj = await createContentObject("blob", new TextEncoder().encode("co-owned"));
    const serialized = serializeContentObject(obj);
    const parsed = await parseContentObject(serialized);
    const before = parsed.bytes.slice();
    serialized.fill(0);
    expect(Array.from(parsed.bytes)).toEqual(Array.from(before));
  });

  it("parseContentObject id is consistent with the owned bytes copy", async () => {
    // The parse copies the payload before the verification await and hashes
    // the owned copy, so the parsed id must equal the hash of the parsed
    // envelope (kind + owned bytes), not the input buffer.
    const obj = await createContentObject("blob", new TextEncoder().encode("co-id-check"));
    const serialized = serializeContentObject(obj);
    const parsed = await parseContentObject(serialized);
    // Mutate the input after parsing; the parsed id must still match the hash
    // of the parsed (owned) envelope.
    serialized.fill(0);
    const recomputed = await sha256(contentFraming(parsed.kind, parsed.bytes));
    expect(parsed.id).toBe(recomputed);
  });

  it("parseContentObject owns Buffer-backed serialized payload views before returning", async () => {
    const obj = await createContentObject(
      "secret-blob",
      new TextEncoder().encode("buffer-parse-content"),
    );
    const serialized = Buffer.from(serializeContentObject(obj));
    const parsed = await parseContentObject(serialized);
    const original = new Uint8Array(parsed.bytes);
    const expectedId = await sha256(contentFraming(parsed.kind, original));

    serialized.fill(0);

    expect(Array.from(parsed.bytes)).toEqual(Array.from(original));
    expect(parsed.id).toBe(obj.id);
    expect(parsed.id).toBe(expectedId);
    expect(await sha256(contentFraming(parsed.kind, parsed.bytes))).toBe(parsed.id);
  });

  it("parse rejects a non-canonical length field (leading zero)", async () => {
    const obj = await createContentObject("blob", new TextEncoder().encode("co-len"));
    const serialized = serializeContentObject(obj);
    // The content framing is `content\0<magic><ver><kind><len>\0<bytes>`.
    // Splice a '0' before the length digit to produce e.g. "06".
    const str = new TextDecoder().decode(serialized);
    const tamperedStr = str.replace(/(\x00\x01\x01\x00)(\d+)\0/, (_m, h, d) => `${h}0${d}\0`);
    const tampered = new TextEncoder().encode(tamperedStr);
    await expect(parseContentObject(tampered)).rejects.toThrow();
  });
});

function expectContentEqual(a: ContentObject, b: ContentObject): void {
  expect(a.id).toBe(b.id);
  expect(a.kind).toBe(b.kind);
  expect(Array.from(a.bytes)).toEqual(Array.from(b.bytes));
}
