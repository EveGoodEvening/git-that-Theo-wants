// C8 real-FS materialization adapter: write a C6 public projection to real
// files, one-way.
//
// The input is the C6-filtered **public projection** — specifically a
// `PublicExportBundle` (the public manifest plus the public content objects
// referenced by its `publicEntries`). It is NEVER the raw `Snapshot` or the
// unfiltered `VirtualTree`. This is the export-privacy invariant (plan §2
// decision 8 / C8 checklist): `gtw export` is always produced from the C6
// `PublicManifest`/public export bundle, and C8 may only materialize that
// C6-filtered projection to real files.
//
// `materialize` is deliberately one-way: it writes public blobs to real files
// at their public paths under `targetDir`. It does not read back, does not
// create a store, and does not touch any private/local-only data — none is
// present on a well-formed `PublicExportBundle`.
//
// Before writing, the bundle is verified with `verifyPublicExportBundle`. This
// rejects a bundle that smuggles extra (e.g. private) objects alongside the
// valid public ones, that has a tampered manifest hash, or that references a
// missing/corrupt blob. Materialization therefore cannot leak private bytes
// through a smuggled object: the verifier enforces exactness (the bundle's
// object set equals exactly the set referenced by `manifest.publicEntries`).

import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, relative, isAbsolute, sep, resolve } from "node:path";
import type { PublicExportBundle } from "../export/public-manifest.ts";
import { verifyPublicExportBundle } from "../export/public-manifest.ts";

/**
 * Typed error raised by `materialize` when the supplied public export bundle
 * fails integrity verification. Materialization is refused rather than
 * writing a possibly-private-smuggled or corrupt projection to disk.
 */
export class MaterializeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterializeError";
  }
}

/**
 * Result of a successful materialization: the absolute target directory and
 * the relative paths (relative to `targetDir`) of the files written, in
 * canonical (sorted by path) order.
 */
export interface MaterializeResult {
  readonly targetDir: string;
  readonly writtenPaths: readonly string[];
}

/**
 * Reject a public entry path that escapes `targetDir` or is otherwise unsafe
 * to materialize.
 *
 * Paths must be relative, non-empty, use only forward-slash (`/`) component
 * separators, and contain NO dot-segment components (`.` or `..`). Dot
 * segments are REJECTED rather than normalized: a manifest carrying `./x`,
 * `a/../b.txt`, or `a/./b` is refused outright. This is stricter than
 * path-normalization — a malicious or malformed manifest can never rely on the
 * materializer to collapse segments, so there is no ambiguity about where a
 * file lands.
 *
 * Platform separators/aliases are also rejected: a backslash (`\`) component
 * separator (Windows), a drive letter, or a UNC path is refused on every
 * platform, so a manifest cannot smuggle a platform-specific escape that the
 * host OS would resolve differently from the manifest author intended.
 *
 * Returns the absolute resolved path inside `targetDir` (only reached for
 * accepted paths, so `resolve` here cannot escape).
 */
function safeResolvePath(targetDir: string, relPath: string): string {
  if (relPath === "") {
    throw new MaterializeError(
      "materialize: public entry has an empty path",
    );
  }
  if (isAbsolute(relPath)) {
    throw new MaterializeError(
      `materialize: public entry path is absolute (not allowed): ${relPath}`,
    );
  }
  // Reject any backslash: it is a Windows path separator and an alias for a
  // component boundary on some platforms. Only `/` is accepted.
  if (relPath.includes("\\")) {
    throw new MaterializeError(
      `materialize: public entry path contains a backslash separator (not allowed): ${relPath}`,
    );
  }
  // Reject any embedded NUL (`\0`): it is invalid in filenames on every
  // common platform and would either be silently truncated by some APIs or
  // surface as a raw OS error after the target has already been cleared. A
  // NUL-bearing path can never be materialized, so refuse it up front during
  // prevalidation, before any filesystem mutations.
  if (relPath.includes("\0")) {
    throw new MaterializeError(
      `materialize: public entry path contains a NUL byte (not allowed): ${relPath}`,
    );
  }
  // Split on the canonical `/` separator and inspect every component. Reject
  // dot segments (`.`/`..`) instead of normalizing them, and reject empty
  // components (leading `/`, `//`, trailing `/`) which would otherwise be
  // silently collapsed.
  const components = relPath.split("/");
  for (const comp of components) {
    if (comp === "") {
      throw new MaterializeError(
        `materialize: public entry path has an empty component (leading/double/trailing slash): ${relPath}`,
      );
    }
    if (comp === "." || comp === "..") {
      throw new MaterializeError(
        `materialize: public entry path contains a dot-segment component "${comp}" (not normalized; rejected): ${relPath}`,
      );
    }
  }
  // Defense in depth: even though dot segments are now rejected, still verify
  // the resolved path stays inside `targetDir`. This catches any future
  // separator/alias that slips past the component check.
  const abs = resolve(targetDir, relPath);
  const rel = relative(targetDir, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new MaterializeError(
      `materialize: public entry path escapes target dir: ${relPath}`,
    );
  }
  return abs;
}

/**
 * Reject manifests whose file paths imply that one public entry must be both a
 * file and an ancestor directory of another public entry (for example `a` and
 * `a/b`). Real filesystems cannot materialize that tree without first writing
 * a partial export and then failing, so detect the conflict before clearing the
 * target directory.
 */
function assertNoPathPrefixConflicts(paths: readonly string[]): void {
  const pathSet = new Set(paths);
  for (const path of paths) {
    for (
      let slash = path.indexOf("/");
      slash !== -1;
      slash = path.indexOf("/", slash + 1)
    ) {
      const parent = path.slice(0, slash);
      if (pathSet.has(parent)) {
        throw new MaterializeError(
          `materialize: path-prefix conflict: "${parent}" prefixes "${path}"`,
        );
      }
    }
  }
}

/**
 * Materialize a C6 public export bundle to real files under `targetDir`.
 *
 * One-way: writes the bundle's public blobs to real files at their public
 * paths. The input MUST be the C6-filtered public projection
 * (`PublicExportBundle`), never the raw `Snapshot`/`VirtualTree`.
 *
 * Privacy invariant: only the public entries in `bundle.manifest.publicEntries`
 * are materialized. The bundle is first verified with
 * `verifyPublicExportBundle`, which rejects any bundle carrying extra
 * (e.g. private) objects, a tampered manifest, or missing/corrupt referenced
 * blobs. A verified bundle carries exactly the referenced public objects and
 * nothing else, so the materialized tree contains only public-projection
 * public entries — no private/local-only bytes, no private paths, no private
 * blob/secret ids, no full `SnapshotId` values, and no private metadata.
 *
 * If `clear` is true (the default), `targetDir` is removed and recreated
 * before writing so no stale files from a prior export linger. Set `clear` to
 * false to merge into an existing directory.
 *
 * Returns `{ targetDir, writtenPaths }` where `writtenPaths` are the relative
 * paths written, in canonical (sorted) order.
 */
export async function materialize(
  bundle: PublicExportBundle,
  targetDir: string,
  options: { clear?: boolean } = {},
): Promise<MaterializeResult> {
  const { clear = true } = options;

  // Verify the bundle before touching the filesystem. This enforces the
  // export-privacy invariant: a verified bundle carries exactly the public
  // objects referenced by the manifest and nothing else.
  const ok = await verifyPublicExportBundle(bundle);
  if (!ok) {
    throw new MaterializeError(
      "materialize: public export bundle failed integrity verification; refusing to write",
    );
  }

  const absTarget = resolve(targetDir);

  // Materialize entries in canonical (sorted by path) order for deterministic
  // filesystem layout. `publicEntries` is already canonical from
  // `buildPublicManifest`, but sort again defensively.
  const entries = [...bundle.manifest.publicEntries].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  );

  // Validate EVERY entry path (and object presence/kind) BEFORE clearing the
  // target or writing any files. An invalid manifest path must leave the
  // existing target untouched and produce no partial export: if any entry's
  // path is unsafe, conflicts with another path's directory prefix, or its
  // referenced object is missing/non-blob, we throw here, before
  // `rmSync`/`mkdirSync`/`writeFileSync` run. This also detects duplicate
  // normalized aliases (two entries resolving to the same absolute path) up
  // front, which would otherwise silently overwrite one file with another's
  // bytes.
  type Plan = { abs: string; rel: string; path: string; bytes: Uint8Array };
  const plans: Plan[] = [];
  const seenAbs = new Set<string>();
  const plannedPaths: string[] = [];
  for (const e of entries) {
    const abs = safeResolvePath(absTarget, e.path);
    if (seenAbs.has(abs)) {
      throw new MaterializeError(
        `materialize: duplicate normalized path alias resolves to ${abs} (from "${e.path}")`,
      );
    }
    seenAbs.add(abs);
    plannedPaths.push(e.path);
    const obj = bundle.objects.get(e.blobId);
    // `verifyPublicExportBundle` already guaranteed presence, but defend in
    // depth: never write a file whose object is missing.
    if (obj === undefined) {
      throw new MaterializeError(
        `materialize: object ${e.blobId} for path ${e.path} missing from bundle`,
      );
    }
    if (obj.kind !== "blob") {
      // A secret-blob must never appear in public entries; verified above, but
      // defend in depth.
      throw new MaterializeError(
        `materialize: object ${e.blobId} for path ${e.path} is not a blob`,
      );
    }
    plans.push({ abs, rel: relative(absTarget, abs).split(sep).join("/"), path: e.path, bytes: obj.bytes });
  }

  assertNoPathPrefixConflicts(plannedPaths);

  // All entries validated. Now it is safe to clear and write: a failure beyond
  // this point is an I/O error, not a manifest-safety violation, and no
  // invalid manifest can trigger a partial export.
  if (clear && existsSync(absTarget)) {
    rmSync(absTarget, { recursive: true, force: true });
  }
  mkdirSync(absTarget, { recursive: true });

  const written: string[] = [];
  for (const p of plans) {
    mkdirSync(dirname(p.abs), { recursive: true });
    // Write the raw public bytes. `writeFileSync` writes the exact bytes; no
    // encoding transformation, so the file is byte-identical to the blob.
    writeFileSync(p.abs, p.bytes);
    written.push(p.rel);
  }

  return { targetDir: absTarget, writtenPaths: written };
}
