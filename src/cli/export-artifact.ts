// C9 export artifact serialization: a machine-readable public export bundle
// artifact emitted by bundle-mode `gtw export`.
//
// The C6 `PublicExportBundle` is the public manifest plus the public content
// objects (blobs) referenced by its `publicEntries`. C6 owns the manifest
// serialization (`serializePublicManifest`); this C9 helper composes it with
// the bundled blobs into one self-describing binary artifact so `gtw export`
// can emit a machine-readable public bundle (not just a human summary) and
// tests can parse it back to assert content and privacy properties.
//
// Layout (all integers are canonical decimal ASCII terminated by NUL):
//   magic        "GTWPUB1\0"   (8 bytes)
//   manifestLen  <decimal>\0
//   manifest     <manifestLen bytes>   (output of `serializePublicManifest`)
//   objectCount  <decimal>\0
//   for each object:
//     blobId     <64 hex chars>\0
//     byteLen    <decimal>\0
//     bytes      <byteLen bytes>
//
// The artifact carries ONLY public data — the C6 manifest (which itself carries
// only `PublicProjectionId`s, public entries, and the manifest hash) and the
// blobs referenced by those public entries. No full `SnapshotId`s, no private
// paths, no timestamps, no messages, no op-log entries, no secret ids.

import { type Hash, asHash, concat, parseDecimalLen } from "../core/ids.ts";
import {
  serializePublicManifest,
  type PublicExportBundle,
  type PublicManifest,
} from "../export/public-manifest.ts";

/** Magic byte prefix for the public export bundle artifact. */
const ARTIFACT_MAGIC = new Uint8Array([
  0x47, 0x54, 0x57, 0x50, 0x55, 0x42, 0x31, 0x00, // "GTWPUB1\0"
]);

/** Encode a non-negative integer as canonical decimal ASCII + NUL terminator. */
function frameCount(n: number): Uint8Array {
  return new TextEncoder().encode(`${n}\0`);
}

/**
 * Serialize a `PublicExportBundle` to a self-describing binary artifact
 * (manifest + public blobs). The bundle MUST already be integrity-verified by
 * the caller (`verifyPublicExportBundle`); this helper does not re-verify.
 */
export function serializePublicExportBundle(bundle: PublicExportBundle): Uint8Array {
  const manifestBytes = serializePublicManifest(bundle.manifest);
  const chunks: Uint8Array[] = [
    ARTIFACT_MAGIC,
    frameCount(manifestBytes.length),
    manifestBytes,
    frameCount(bundle.objects.size),
  ];
  for (const [blobId, obj] of bundle.objects) {
    chunks.push(new TextEncoder().encode(`${blobId}\0`));
    chunks.push(frameCount(obj.bytes.length));
    chunks.push(new Uint8Array(obj.bytes));
  }
  return concat(chunks);
}

/** Parsed public export bundle artifact: manifest + objects map. */
export interface ParsedExportArtifact {
  readonly manifest: PublicManifest;
  readonly objects: ReadonlyMap<Hash, { readonly kind: "blob"; readonly bytes: Uint8Array }>;
}

/**
 * Parse a `serializePublicExportBundle` artifact back into a manifest + objects
 * map. Throws on malformed framing. Does NOT re-verify the manifest self-hash or
 * blob content hashes; callers that need integrity should run
 * `verifyPublicExportBundle` on the reconstructed bundle.
 */
export function parsePublicExportArtifact(data: Uint8Array): ParsedExportArtifact {
  const magicLen = ARTIFACT_MAGIC.length;
  if (data.length < magicLen) {
    throw new Error("public export artifact: too short for magic");
  }
  for (let i = 0; i < magicLen; i++) {
    if (data[i] !== ARTIFACT_MAGIC[i]) {
      throw new Error("public export artifact: bad magic");
    }
  }
  let off = magicLen;
  const { value: manifestLen, end: mLenEnd } = readCount(data, off, "manifestLen");
  off = mLenEnd;
  if (off + manifestLen > data.length) {
    throw new Error("public export artifact: truncated manifest");
  }
  const manifestBytes = data.subarray(off, off + manifestLen);
  off += manifestLen;
  // `parsePublicManifest` is async (it verifies the self-hash); but to keep
  // this helper sync and avoid a second hash pass, we reuse the sync framing
  // parser inline. The manifest was already verified before serialization, so
  // we parse structurally only.
  const manifest = parseManifestSync(manifestBytes);
  const { value: objectCount, end: ocEnd } = readCount(data, off, "objectCount");
  off = ocEnd;
  const objects = new Map<Hash, { readonly kind: "blob"; readonly bytes: Uint8Array }>();
  for (let i = 0; i < objectCount; i++) {
    const { str: blobIdStr, end: bIdEnd } = readUntil(data, off);
    off = bIdEnd;
    const blobId = asHash(blobIdStr);
    const { value: byteLen, end: byteLenEnd } = readCount(data, off, "byteLen");
    off = byteLenEnd;
    if (off + byteLen > data.length) {
      throw new Error("public export artifact: truncated object bytes");
    }
    const bytes = new Uint8Array(data.subarray(off, off + byteLen));
    off += byteLen;
    objects.set(blobId, { kind: "blob", bytes });
  }
  if (off !== data.length) {
    throw new Error("public export artifact: trailing data");
  }
  return { manifest, objects };
}

/** Read a NUL-terminated ASCII field from `data` starting at `offset`. */
function readUntil(
  data: Uint8Array,
  offset: number,
): { str: string; end: number } {
  let end = offset;
  while (end < data.length && data[end] !== 0x00) end++;
  if (end >= data.length) {
    throw new Error("public export artifact: missing NUL terminator");
  }
  const str = new TextDecoder().decode(data.subarray(offset, end));
  return { str, end: end + 1 };
}

/** Read a canonical decimal count field terminated by NUL. */
function readCount(
  data: Uint8Array,
  offset: number,
  field: string,
): { value: number; end: number } {
  const { str, end } = readUntil(data, offset);
  return { value: parseDecimalLen(str, field), end };
}

/**
 * Structural (sync) manifest parser mirroring C6's `parsePublicManifest` framing
 * without the async self-hash verification. The artifact is produced from a
 * verified bundle, so structural recovery is sufficient here.
 */
function parseManifestSync(data: Uint8Array): PublicManifest {
  // Delegate to the canonical async parser's framing by re-deriving the fields
  // from the known layout. To avoid duplicating C6's framing logic, we import
  // the async parser and call it — but we cannot await in a sync function.
  // Instead, reconstruct the manifest object from the serialized fields using
  // the same framing C6 defines. This is a thin structural mirror.
  if (data[0] !== 0x07) throw new Error("public manifest: bad magic");
  if (data[1] !== 0x01) throw new Error("public manifest: unsupported version");
  let off = 2;
  const readField = (): string => {
    const { str, end } = readUntil(data, off);
    off = end;
    return str;
  };
  const bundleVersion = Number(readField());
  if (bundleVersion !== 1) {
    throw new Error(`public manifest: bad bundleVersion ${bundleVersion}`);
  }
  const projCount = Number(readField());
  const publicProjectionIds: string[] = [];
  for (let i = 0; i < projCount; i++) publicProjectionIds.push(readField());
  const entryCount = Number(readField());
  const publicEntries: { path: string; blobId: Hash }[] = [];
  for (let i = 0; i < entryCount; i++) {
    const pathLen = Number(readField());
    if (off + pathLen > data.length) {
      throw new Error("public manifest: truncated path");
    }
    const path = new TextDecoder().decode(data.subarray(off, off + pathLen));
    off += pathLen;
    if (data[off] !== 0x00) throw new Error("public manifest: missing path terminator");
    off++;
    if (off + 64 > data.length) {
      throw new Error("public manifest: truncated blobId");
    }
    const blobId = asHash(new TextDecoder().decode(data.subarray(off, off + 64)));
    off += 64;
    publicEntries.push({ path, blobId });
  }
  if (off + 64 !== data.length) {
    throw new Error("public manifest: trailing data after hash");
  }
  const publicManifestHash = asHash(
    new TextDecoder().decode(data.subarray(off, off + 64)),
  );
  return {
    bundleVersion: 1 as const,
    publicProjectionIds: [...publicProjectionIds] as PublicManifest["publicProjectionIds"],
    publicEntries: [...publicEntries] as PublicManifest["publicEntries"],
    publicManifestHash,
  };
}
