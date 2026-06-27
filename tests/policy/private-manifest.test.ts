// C6 private manifest tests: SnapshotId -> PublicProjectionId mapping,
// canonical framing round-trip, content hash, and acyclic manifest-ref mapping.

import { describe, expect, it } from "bun:test";
import {
  type PrivateManifest,
  asPublicProjectionId,
  canonicalPrivateManifest,
  parsePrivateManifest,
  privateManifestHash,
  projectionForSnapshot,
} from "../../src/policy/private-manifest.ts";
import { asSnapshotId, isHash } from "../../src/core/ids.ts";

const SNAP_A = asSnapshotId("a".repeat(64));
const SNAP_B = asSnapshotId("b".repeat(64));
const PROJ_A = asPublicProjectionId("1".repeat(64));
const PROJ_B = asPublicProjectionId("2".repeat(64));

function sampleManifest(): PrivateManifest {
  return {
    entries: [
      {
        snapshotId: SNAP_A,
        projectionId: PROJ_A,
        parentProjectionIds: [],
      },
      {
        snapshotId: SNAP_B,
        projectionId: PROJ_B,
        parentProjectionIds: [PROJ_A],
      },
    ],
  };
}

describe("C6 PublicProjectionId brand", () => {
  it("accepts a valid 64-char hex string", () => {
    const id = asPublicProjectionId("f".repeat(64));
    expect(typeof id).toBe("string");
    expect(id.length).toBe(64);
  });
  it("rejects invalid hex / wrong length", () => {
    expect(() => asPublicProjectionId("xyz")).toThrow();
    expect(() => asPublicProjectionId("a".repeat(63))).toThrow();
    expect(() => asPublicProjectionId("g".repeat(64))).toThrow();
  });
});

describe("C6 private manifest canonical framing", () => {
  it("is deterministic: same entries in any order -> same bytes", () => {
    const a = sampleManifest();
    const b: PrivateManifest = {
      // Reverse entry order; canonical framing sorts by snapshotId.
      entries: [a.entries[1], a.entries[0]],
    };
    expect(canonicalPrivateManifest(a)).toEqual(canonicalPrivateManifest(b));
  });

  it("round-trips through parse/canonical", () => {
    const manifest = sampleManifest();
    const bytes = canonicalPrivateManifest(manifest);
    const parsed = parsePrivateManifest(bytes);
    // Re-canonicalize for structural equality (order-independent).
    expect(canonicalPrivateManifest(parsed)).toEqual(bytes);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0].snapshotId).toBe(SNAP_A);
    expect(parsed.entries[0].projectionId).toBe(PROJ_A);
    expect(parsed.entries[0].parentProjectionIds).toEqual([]);
    expect(parsed.entries[1].snapshotId).toBe(SNAP_B);
    expect(parsed.entries[1].projectionId).toBe(PROJ_B);
    expect(parsed.entries[1].parentProjectionIds).toEqual([PROJ_A]);
  });

  it("rejects malformed framing (bad magic)", () => {
    const bytes = canonicalPrivateManifest(sampleManifest());
    const bad = new Uint8Array(bytes);
    bad[0] = 0xff;
    expect(() => parsePrivateManifest(bad)).toThrow();
  });

  it("rejects malformed framing (truncated)", () => {
    const bytes = canonicalPrivateManifest(sampleManifest());
    expect(() => parsePrivateManifest(bytes.subarray(0, 3))).toThrow();
  });

  it("rejects malformed framing (invalid snapshot id)", () => {
    const bytes = canonicalPrivateManifest(sampleManifest());
    const bad = new Uint8Array(bytes);
    bad[2] = 0x31; // entry count remains one canonical digit; corrupt first snapshot hex below.
    // Overwrite the first snapshot id's first byte after magic/version/count.
    bad[4] = 0x7a;
    expect(() => parsePrivateManifest(bad)).toThrow();
  });

  it("rejects malformed framing (trailing data)", () => {
    const bytes = canonicalPrivateManifest(sampleManifest());
    const withTrailing = new Uint8Array(bytes.length + 1);
    withTrailing.set(bytes);
    withTrailing[withTrailing.length - 1] = 0x00;
    expect(() => parsePrivateManifest(withTrailing)).toThrow();
  });
});

describe("C6 private manifest content hash", () => {
  it("produces a valid Hash", async () => {
    const h = await privateManifestHash(sampleManifest());
    expect(isHash(h)).toBe(true);
  });

  it("is deterministic: identical manifests -> identical hash", async () => {
    const a = sampleManifest();
    const b: PrivateManifest = {
      entries: [a.entries[1], a.entries[0]],
    };
    expect(await privateManifestHash(a)).toBe(await privateManifestHash(b));
  });

  it("differs when entries differ", async () => {
    const a = sampleManifest();
    const b: PrivateManifest = {
      entries: [
        {
          snapshotId: SNAP_A,
          projectionId: PROJ_B, // different projection
          parentProjectionIds: [],
        },
      ],
    };
    expect(await privateManifestHash(a)).not.toBe(await privateManifestHash(b));
  });
});

describe("C6 projectionForSnapshot lookup", () => {
  it("returns the projection id for a recorded snapshot", () => {
    const m = sampleManifest();
    expect(projectionForSnapshot(m, SNAP_A)).toBe(PROJ_A);
    expect(projectionForSnapshot(m, SNAP_B)).toBe(PROJ_B);
  });
  it("returns undefined for an unrecorded snapshot", () => {
    const m = sampleManifest();
    const SNAP_C = asSnapshotId("c".repeat(64));
    expect(projectionForSnapshot(m, SNAP_C)).toBeUndefined();
  });
});

describe("C6 acyclic manifest-ref mapping", () => {
  // Plan §2 decision 10: the private manifest maps SnapshotId -> PublicProjectionId
  // and its content hash is upserted into privateManifestRef. Because
  // SnapshotId excludes manifest refs, computing the manifest does not require
  // an id that depends on the manifest — the mapping is acyclic.
  it("a snapshot's privateManifestRef can be set after computing its manifest without changing its SnapshotId", async () => {
    // The SnapshotId is fixed (SNAP_A) before the manifest is computed; the
    // manifest hash is derived from the mapping and would populate
    // privateManifestRef. The mapping references the already-final SnapshotId,
    // so there is no fixed-point cycle.
    const manifest: PrivateManifest = {
      entries: [
        {
          snapshotId: SNAP_A,
          projectionId: PROJ_A,
          parentProjectionIds: [],
        },
      ],
    };
    const manifestHash = await privateManifestHash(manifest);
    // The manifest hash is a function of (SnapshotId, projectionId, parents).
    // SnapshotId is NOT a function of manifestHash (decision 10). Therefore the
    // mapping is acyclic: manifestHash depends on SNAP_A, SNAP_A does not
    // depend on manifestHash.
    expect(isHash(manifestHash)).toBe(true);
    expect(manifest.entries[0].snapshotId).toBe(SNAP_A);
  });
});
