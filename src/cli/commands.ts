// C9 thin CLI commands: parsing and delegation only.
//
// Each command parses its argv tail, delegates to the core/vfs/snapshot/
// policy/workspace/fs APIs through the `CliSession`, and returns a string to
// print to stdout. No business logic lives here — the session holds the state
// and the core modules own the semantics.
//
// Command surface (plan C9, documented order):
//   init, status, snapshot create/show/list, bookmark list/set,
//   tag create/list, restore, export, publish, publish-check, unpublish
//
// There is no `fetch` command (plan §5: no network transfer; public-peer
// visibility is in-process via the public manifest/bundle). `export` is
// always produced from the C6 `PublicManifest`/public export bundle — never
// the raw snapshot/`VirtualTree`. When C8 has landed (status `[x]`), `export
// --to <dir>` materializes the C6 public projection to real files via C8's
// `materialize`; otherwise it emits the C6 in-memory public bundle.

import { type SnapshotId } from "../core/ids.ts";
import { loadSnapshot } from "../snapshot/snapshot.ts";
import { NotFound } from "../store/store.ts";
import {
  publish as publishTransition,
  unpublish as unpublishTransition,
} from "../policy/transitions.ts";
import { canPublish } from "../policy/authorization.ts";
import {
  derivePublicProjection,
  buildPublicExportBundle,
  verifyPublicExportBundle,
} from "../export/public-manifest.ts";
import { materialize } from "../vfs/materialize.ts";
import { serializePublicExportBundle } from "./export-artifact.ts";
import {
  CliError,
  initSession,
  requireSession,
  saveSession,
  type CliSession,
} from "./session.ts";

// --- argv helpers ----------------------------------------------------------

/** Pop the next token from `argv`, or throw a usage `CliError`. */
function nextArg(argv: string[], what: string): string {
  const v = argv.shift();
  if (v === undefined) {
    throw new CliError(`missing ${what}`);
  }
  return v;
}

/** Optional `--flag value` pair: returns the value or `undefined`. */
function optValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (v === undefined) {
    throw new CliError(`missing value for ${flag}`);
  }
  argv.splice(i, 1);
  return v;
}

// --- output helpers --------------------------------------------------------

/** Format a snapshot id as a short prefix for human-facing output. */
function short(id: SnapshotId): string {
  return id.slice(0, 12);
}

// --- commands --------------------------------------------------------------
/** `gtw init [--fs <dir>]` — create a fresh session (in-memory or durable). */
export async function cmdInit(argv: string[]): Promise<string> {
  const fs = optValue(argv, "--fs");
  const s = await initSession();
  if (fs !== undefined) s.fsRoot = fs;
  await saveSession();
  return fs === undefined
    ? "initialized empty gtw session\n"
    : `initialized empty gtw session (export root: ${fs})\n`;
}

/** `gtw status` — summarize the current workspace and recorded pointers. */
export async function cmdStatus(_argv: string[]): Promise<string> {
  const s = await requireSession();
  const ws = s.current;
  const head = ws.currentSnapshotId;
  const lines: string[] = [];
  lines.push("workspace: " + ws.id);
  lines.push("head: " + (head === null ? "(none)" : short(head)));
  lines.push("dirty: " + (ws.dirty ? "yes" : "no"));
  const bookmarks = s.bookmarks.listBookmarks();
  const tags = s.bookmarks.listTags();
  lines.push("bookmarks: " + (bookmarks.length === 0
    ? "(none)"
    : bookmarks.join(", ")));
  lines.push("tags: " + (tags.length === 0 ? "(none)" : tags.join(", ")));
  lines.push("snapshots: " + s.store.listSnapshots().length);
  return lines.join("\n") + "\n";
}

/** `gtw snapshot create <path> <content> [--message <m>]` — write + auto-snapshot. */
export async function cmdSnapshotCreate(argv: string[]): Promise<string> {
  const s = await requireSession();
  const path = nextArg(argv, "path");
  const content = nextArg(argv, "content");
  const message = optValue(argv, "--message") ?? "snapshot create";
  const ws = s.current;
  await ws.write(path, new TextEncoder().encode(content));
  const boundary = await ws.commandBoundary({ message });
  if (boundary === null) {
    return "no changes to snapshot\n";
  }
  const { snapshot } = boundary;
  // Default new snapshots to `private` visibility (C6 default).
  s.setSnapshotVisibility(snapshot.id, "private");
  await saveSession();
  return `snapshot ${short(snapshot.id)} created (${snapshot.tree.size} entries)\n`;
}

/** `gtw snapshot show <id>` — print a snapshot's core state. */
export async function cmdSnapshotShow(argv: string[]): Promise<string> {
  const s = await requireSession();
  const idArg = nextArg(argv, "snapshot id");
  const snap = await loadSnapshot(s.resolveSnapshotId(idArg), s.store);
  const lines: string[] = [];
  lines.push("id: " + snap.id);
  lines.push("parent: " + (snap.parentId === null ? "(none)" : snap.parentId));
  lines.push("timestamp: " + snap.timestamp);
  lines.push("message: " + snap.message);
  lines.push("immutable: " + snap.immutable);
  lines.push("visibility: " + s.visibilityFor(snap.id).state);
  lines.push("entries:");
  for (const [path, blobId] of snap.tree) {
    lines.push(`  ${path}  ${short(blobId)}`);
  }
  return lines.join("\n") + "\n";
}

/** `gtw snapshot list` — list all stored snapshot ids in insertion order. */
export async function cmdSnapshotList(_argv: string[]): Promise<string> {
  const s = await requireSession();
  const ids = s.store.listSnapshots();
  if (ids.length === 0) return "(no snapshots)\n";
  const lines: string[] = [];
  for (const id of ids) {
    const vis = s.visibilityFor(id).state;
    lines.push(`${short(id)}  ${vis}`);
  }
  return lines.join("\n") + "\n";
}

/** `gtw bookmark list` — list bookmark names + targets. */
export async function cmdBookmarkList(_argv: string[]): Promise<string> {
  const s = await requireSession();
  const names = s.bookmarks.listBookmarks();
  if (names.length === 0) return "(no bookmarks)\n";
  const lines: string[] = [];
  for (const n of names) {
    lines.push(`${n}  ${short(s.bookmarks.getBookmark(n))}`);
  }
  return lines.join("\n") + "\n";
}

/** `gtw bookmark set <name> <snapshot-id>` — create or move a bookmark. */
export async function cmdBookmarkSet(argv: string[]): Promise<string> {
  const s = await requireSession();
  const name = nextArg(argv, "bookmark name");
  const target = s.resolveSnapshotId(nextArg(argv, "snapshot id"));
  if (s.bookmarks.hasBookmark(name)) {
    s.bookmarks.moveBookmark(name, target);
    await saveSession();
    return `bookmark ${name} moved to ${short(target)}\n`;
  }
  s.bookmarks.createBookmark(name, target);
  await saveSession();
  return `bookmark ${name} set to ${short(target)}\n`;
}

/** `gtw tag create <name> <snapshot-id>` — create a tag (op-log recorded). */
export async function cmdTagCreate(argv: string[]): Promise<string> {
  const s = await requireSession();
  const name = nextArg(argv, "tag name");
  const target = s.resolveSnapshotId(nextArg(argv, "snapshot id"));
  s.bookmarks.createTag(name, target);
  await saveSession();
  return `tag ${name} created at ${short(target)}\n`;
}

/** `gtw tag list` — list tag names + targets. */
export async function cmdTagList(_argv: string[]): Promise<string> {
  const s = await requireSession();
  const names = s.bookmarks.listTags();
  if (names.length === 0) return "(no tags)\n";
  const lines: string[] = [];
  for (const n of names) {
    lines.push(`${n}  ${short(s.bookmarks.getTag(n))}`);
  }
  return lines.join("\n") + "\n";
}

/** `gtw restore <snapshot-id>` — check out a snapshot into the current workspace. */
export async function cmdRestore(argv: string[]): Promise<string> {
  const s = await requireSession();
  const id = s.resolveSnapshotId(nextArg(argv, "snapshot id"));
  await s.current.checkoutId(id);
  await saveSession();
  return `restored ${short(id)} into workspace ${s.current.id}\n`;
}

/**
 * `gtw export [--to <dir>] [--out <file>] [--snapshot <id>]` — emit the C6
 * public export bundle for the snapshot chain ending at `--snapshot` (default:
 * current head).
 *
 * Always produced from the C6 `PublicManifest`/public export bundle — never
 * the raw snapshot/`VirtualTree`. Three modes:
 *   - `--to <dir>`: C8 real-FS materialization (writes public blobs to files).
 *   - `--out <file>`: write the machine-readable public bundle artifact to a
 *     file (manifest + public blobs, self-describing binary).
 *   - bare (no flags): print the machine-readable public bundle artifact to
 *     stdout, followed by a one-line human summary on stderr.
 */
export async function cmdExport(argv: string[]): Promise<string> {
  const s = await requireSession();
  const to = optValue(argv, "--to");
  const out = optValue(argv, "--out");
  const snapshotArg = optValue(argv, "--snapshot");
  const headId = snapshotArg !== undefined
    ? s.resolveSnapshotId(snapshotArg)
    : s.current.currentSnapshotId;
  if (headId === null) {
    throw new CliError("no current snapshot to export");
  }
  const bundle = await buildExportBundleFor(s, headId);
  const ok = await verifyPublicExportBundle(bundle);
  if (!ok) {
    throw new CliError("export bundle failed integrity verification");
  }
  const entryPaths = bundle.manifest.publicEntries.map((e) => e.path);
  if (to !== undefined) {
    // C8 real-FS materialization path: writes only the C6 public projection.
    const res = await materialize(bundle, to);
    return [
      `exported ${entryPaths.length} public entries to ${res.targetDir}`,
      ...res.writtenPaths.map((p) => `  ${p}`),
    ].join("\n") + "\n";
  }
  // Bundle mode: emit the machine-readable serialized C6 public export bundle
  // (manifest + public blobs), not just a human summary.
  const artifact = serializePublicExportBundle(bundle);
  if (out !== undefined) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(out, artifact);
    return `exported public bundle artifact (${artifact.length} bytes, manifest hash ${bundle.manifest.publicManifestHash.slice(0, 12)}) to ${out}\n`;
  }
  // Print the artifact bytes to stdout so callers can capture them directly.
  process.stdout.write(artifact);
  // Human summary on stderr keeps stdout a clean machine-readable channel.
  process.stderr.write(
    `exported public bundle artifact (${artifact.length} bytes, manifest hash ${bundle.manifest.publicManifestHash.slice(0, 12)})\n`,
  );
  // The dispatcher writes the returned string to stdout after the handler
  // returns; return "" so it does not append anything to the artifact bytes.
  return "";
}

/** `gtw publish <snapshot-id>` — transition a snapshot to public (op-log event). */
export async function cmdPublish(argv: string[]): Promise<string> {
  const s = await requireSession();
  const id = s.resolveSnapshotId(nextArg(argv, "snapshot id"));
  try {
    s.store.getSnapshot(id);
  } catch (err) {
    if (err instanceof NotFound && err.kind === "snapshot") {
      throw new CliError(`no snapshot matching id: ${id}`);
    }
    throw err;
  }

  const vis = s.visibilityLog();
  const state = vis.get(id);
  // Authorization: owner role for the in-process demo.
  const ownerId = "owner" as unknown as import("../core/ids.ts").ActorId;
  if (!canPublish(state, { actor: ownerId, ownerId })) {
    throw new CliError(
      `cannot publish snapshot ${short(id)} from state ${state}`,
    );
  }
  publishTransition(s.log, vis, id);
  await saveSession();
  // The op-log event is the source of truth; `visibilityFor` replays it.
  return `published ${short(id)}: ${state} -> public\n`;
}

/** `gtw publish-check <snapshot-id>` — report a snapshot's current visibility. */
export async function cmdPublishCheck(argv: string[]): Promise<string> {
  const s = await requireSession();
  const id = s.resolveSnapshotId(nextArg(argv, "snapshot id"));
  const vis = s.visibilityLog();
  const state = vis.get(id);
  const transitioned = vis.hasTransitioned(id);
  return [
    `snapshot ${short(id)}`,
    `visibility: ${state}`,
    `transitioned: ${transitioned}`,
  ].join("\n") + "\n";
}

/** `gtw unpublish <snapshot-id>` — re-privatize a public snapshot (new op-log event). */
export async function cmdUnpublish(argv: string[]): Promise<string> {
  const s = await requireSession();
  const id = s.resolveSnapshotId(nextArg(argv, "snapshot id"));
  const vis = s.visibilityLog();
  const state = vis.get(id);
  if (state !== "public") {
    throw new CliError(
      `cannot unpublish snapshot ${short(id)} from state ${state} (only public can be unpublished)`,
    );
  }
  unpublishTransition(s.log, vis, id);
  await saveSession();
  // The op-log event is the source of truth; `visibilityFor` replays it.
  return `unpublished ${short(id)}: public -> private\n`;
}

// --- export bundle derivation (delegates to C6) ----------------------------

/**
 * Build the C6 public export bundle for the snapshot chain ending at `headId`.
 * Walks the parent chain (oldest-first), derives the public projection from
 * the session's visibility table, and builds the bundle from the public
 * projection nodes. Raw snapshots/`VirtualTree` are never exported.
 */
async function buildExportBundleFor(
  s: CliSession,
  headId: SnapshotId,
): Promise<import("../export/public-manifest.ts").PublicExportBundle> {
  // Assemble the ancestor chain oldest-first.
  const chain: import("../snapshot/snapshot.ts").Snapshot[] = [];
  let curId: SnapshotId | null = headId;
  const visited = new Set<SnapshotId>();
  while (curId !== null) {
    if (visited.has(curId)) {
      throw new CliError(`snapshot parent cycle at ${short(curId)}`);
    }
    visited.add(curId);
    const snap = await loadSnapshot(curId, s.store);
    chain.unshift(snap);
    curId = snap.parentId;
  }
  const { nodes } = await derivePublicProjection(chain, s.visibilityMap());
  return buildPublicExportBundle(nodes, s.store);
}
