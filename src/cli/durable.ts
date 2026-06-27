// C9 durable local CLI state: a small on-disk backing under `.gtw/cli/` that
// lets the planned command flow run across separate `gtw` process invocations.
//
// The process-global in-memory `CliSession` is lost when a `gtw` subprocess
// exits. To make `gtw init` → `gtw snapshot create` → `gtw tag create` →
// `gtw publish` → `gtw export` → `gtw publish-check` → `gtw unpublish` work as
// real subprocess invocations, we persist the session state to disk and reload
// it on the next invocation.
//
// What is persisted (all under `<root>/cli/`, where `<root>` is `.gtw` by
// default or `--root <dir>`):
//   - The C2 `Store` graphs (objects / acls / snapshots / manifest-refs) via
//     the existing C8 `FsStore` backend rooted at `<root>`. This is the durable
//     object store; we do not re-implement it.
//   - `op-log.jsonl` — the append-only op-log events (one JSON object per
//     line), so `replayVisibilityLog` and the audit history survive restarts.
//   - `bookmarks.json` — the bookmark/tag maps (name → SnapshotId). The
//     `Bookmarks` registry does not expose a log-replay constructor, so the
//     maps are persisted directly and repopulated through the public
//     `createBookmark` / `createTag` mutators on load (which append fresh
//     pointer-move events to the in-memory log). Pointer-move events are
//     therefore regenerated on every load rather than re-appended from disk,
//     so they never accumulate across invocations.
//   - `visibility.json` — the per-snapshot non-public initial visibility
//     states and the per-snapshot per-path visibility overrides. These are not
//     op-log events (only `publish` / `unpublish` are), so they need their own
//     durable home.
//   - `workspace.json` — the current workspace id, head snapshot id, dirty
//     flag, and the working-tree entries (path → blob id). The working tree is
//     a `VirtualTree` of path → content `Hash` referencing blobs already in the
//     `FsStore`, so persisting the path → blob-id map is sufficient to rebuild
//     it.
//
// This is deliberately local-only (no server, no network) and uses existing
// core serialization / store APIs (`FsStore`, `serializePublicManifest`,
// `OpLog` append helpers, `Bookmarks` mutators, `WorkspaceManager`). No
// business logic lives here — only load/save of the session shell.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hash, SnapshotId } from "../core/ids.ts";
import { asHash, asSnapshotId, isHash } from "../core/ids.ts";
import { FsStore } from "../store/fs-store.ts";
import { OpLog, type OpLogEvent, type OpKind } from "../snapshot/oplog.ts";
import { Bookmarks } from "../snapshot/bookmark.ts";
import { WorkspaceManager } from "../workspace/workspace.ts";
import type { VisibilityState } from "../policy/visibility.ts";
import { CliSession, registerDurableFactory, type SessionFactory } from "./session.ts";

/** Magic marker for the durable CLI state directory layout. */
const DURABLE_LAYOUT_VERSION = 1;

/** A serialized op-log event record (JSON-shaped). */
interface SerializedOpLogEvent {
  readonly seq: number;
  readonly kind: OpKind;
  readonly timestamp: number;
  readonly name?: string;
  readonly from?: string | null;
  readonly to?: string;
  readonly snapshotId?: string;
  readonly parentId?: string | null;
}

/** Serialized bookmark/tag map (name → SnapshotId hex). */
type PointerMap = Record<string, string>;

/** Serialized per-snapshot visibility tables. */
interface SerializedVisibility {
  /** Per-snapshot non-public initial visibility states. */
  readonly snapshotStates: Record<string, VisibilityState>;
  /** Per-snapshot per-path visibility overrides: snapshotId → path → state. */
  readonly pathStates: Record<string, Record<string, VisibilityState>>;
}

/** Serialized current workspace state. */
interface SerializedWorkspace {
  readonly workspaceId: string;
  /** Head snapshot id, or null before the first snapshot. */
  readonly head: string | null;
  /** Whether the working tree has unsnapshotted mutations. */
  readonly dirty: boolean;
  /** Working-tree entries: path → blob id (content Hash hex). */
  readonly tree: Record<string, string>;
}

/** Top-level persisted CLI state header. */
interface CliStateFile {
  readonly layoutVersion: number;
  readonly bookmarks: PointerMap;
  readonly tags: PointerMap;
  readonly visibility: SerializedVisibility;
  readonly workspace: SerializedWorkspace;
}

/**
 * Durable CLI session: a `CliSession` backed by an `FsStore` at `root` plus the
 * small JSON state files under `<root>/cli/`. Constructed by `loadDurable`;
 * mutations are flushed to disk by `save()`.
 */
export class DurableCliSession extends CliSession {
  readonly root: string;
  private readonly cliDir: string;
  private readonly stateFile: string;
  private readonly opLogFile: string;

  constructor(root: string) {
    // Build the shell with the durable store + a fresh op-log + bookmarks.
    const store = new FsStore(root);
    const log = new OpLog();
    const bookmarks = new Bookmarks(log);
    const workspaces = new WorkspaceManager(store, log, bookmarks);
    super(store, log, bookmarks, workspaces);
    this.root = root;
    this.cliDir = join(root, "cli");
    this.stateFile = join(this.cliDir, "state.json");
    this.opLogFile = join(this.cliDir, "op-log.jsonl");
    mkdirSync(this.cliDir, { recursive: true });
  }

  /**
   * Persist the full session shell to disk: op-log events, bookmark/tag maps,
   * visibility tables, and the current workspace state. The `FsStore` owns its
   * own object/snapshot/manifest-ref persistence (writes happen inline as
   * commands mutate the store), so this only flushes the CLI-owned shell.
   */
  save(): void {
    mkdirSync(this.cliDir, { recursive: true });

    // Op-log events, one JSON object per line. Pointer-move events are
    // regenerated on load (see `loadDurable`), so we persist every event
    // faithfully; the loader skips pointer-move events when re-appending and
    // regenerates them from the bookmark/tag maps.
    const events = this.log.list();
    const lines = events.map((e) => JSON.stringify(serializeEvent(e)));
    writeFileSync(this.opLogFile, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");

    // Bookmark / tag maps.
    const bookmarks: PointerMap = {};
    for (const name of this.bookmarks.listBookmarks()) {
      bookmarks[name] = this.bookmarks.getBookmark(name);
    }
    const tags: PointerMap = {};
    for (const name of this.bookmarks.listTags()) {
      tags[name] = this.bookmarks.getTag(name);
    }

    // Visibility tables (read back through the private getters via the public
    // `CliSession` surface).
    const snapshotStates = this.snapshotStatesRecord();
    const pathStates = this.pathStatesRecord();

    // Current workspace state.
    const ws = this.current;
    const tree = ws.workingCopy.tree;
    const treeRecord: Record<string, string> = {};
    for (const [path, blobId] of tree.entries) {
      treeRecord[path] = blobId;
    }
    const workspace: SerializedWorkspace = {
      workspaceId: ws.id,
      head: ws.currentSnapshotId,
      dirty: ws.dirty,
      tree: treeRecord,
    };

    const state: CliStateFile = {
      layoutVersion: DURABLE_LAYOUT_VERSION,
      bookmarks,
      tags,
      visibility: { snapshotStates, pathStates },
      workspace,
    };
    writeFileSync(this.stateFile, JSON.stringify(state, null, 2), "utf8");
  }
}

/**
 * Load a durable CLI session from `root`, or initialize a fresh one if no state
 * exists yet (the `init` command). Reconstructs the `FsStore`, replays the
 * op-log, repopulates bookmarks/tags and visibility tables, and checks out the
 * current workspace.
 */
/**
 * Create a fresh durable session at `root` (the `init` command). Always starts
 * empty; any pre-existing state is left untouched (a re-init over an existing
 * `.gtw` keeps the object store but resets the CLI shell). The fresh state is
 * saved immediately so a subsequent `gtw <cmd>` in another process finds it.
 */
export async function createDurable(root: string): Promise<DurableCliSession> {
  const s = new DurableCliSession(root);
  s.save();
  return s;
}

/**
 * Load an existing durable session at `root`, or return `null` if no session
 * was ever initialized there (no `cli/state.json`). Reconstructs the `FsStore`,
 * replays the op-log, repopulates bookmarks/tags and visibility tables, and
 * checks out the current workspace.
 */
export async function loadDurable(root: string): Promise<DurableCliSession | null> {
  const cliDir = join(root, "cli");
  const stateFile = join(cliDir, "state.json");
  if (!existsSync(stateFile)) {
    // No prior `init`: callers (requireSession) should error, not silently
    // create state.
    return null;
  }
  const s = new DurableCliSession(root);
  const opLogFile = join(cliDir, "op-log.jsonl");

  // --- Reload op-log events (skip pointer-move; regenerated below) ---
  if (existsSync(opLogFile)) {
    const text = readFileSync(opLogFile, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const rec = JSON.parse(trimmed) as SerializedOpLogEvent;
      // Pointer-move events are regenerated from the bookmark/tag maps below,
      // so skip them here to avoid duplication.
      if (rec.kind === "bookmark-move" || rec.kind === "tag-move") continue;
      reappendEvent(s.log, rec);
    }
  }

  // --- Reload the CLI state header ---
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as CliStateFile;

  // --- Repopulate bookmarks/tags via public mutators ---
  // `createBookmark` / `createTag` append fresh pointer-move events to the
  // in-memory log. The persisted pointer-move events were skipped above, so
  // no duplication. Move history is not preserved across invocations (only the
  // final targets are), which is sufficient for the prototype planned flow.
  for (const [name, idHex] of Object.entries(state.bookmarks)) {
    if (isHash(idHex)) s.bookmarks.createBookmark(name, asSnapshotId(idHex));
  }
  for (const [name, idHex] of Object.entries(state.tags)) {
    if (isHash(idHex)) s.bookmarks.createTag(name, asSnapshotId(idHex));
  }

  // --- Repopulate visibility tables ---
  for (const [idHex, vstate] of Object.entries(state.visibility.snapshotStates)) {
    if (isHash(idHex)) s.setSnapshotVisibility(asSnapshotId(idHex), vstate);
  }
  for (const [idHex, paths] of Object.entries(state.visibility.pathStates)) {
    if (!isHash(idHex)) continue;
    const snapId = asSnapshotId(idHex);
    for (const [path, vstate] of Object.entries(paths)) {
      s.setPathVisibility(snapId, path, vstate);
    }
  }

  // --- Reconstruct the current workspace ---
  await restoreWorkspace(s, state.workspace);

  return s;
}

/**
 * Reconstruct the current workspace from its serialized state. The planned
 * command flow always exits at a clean command boundary (auto-snapshot resets
 * `dirty`), so the common case is a clean checkout of `head`. A dirty working
 * tree (unsnapshotted mutations) is reconstructed best-effort by writing each
 * persisted entry on top of the head checkout.
 */
async function restoreWorkspace(
  s: DurableCliSession,
  ws: SerializedWorkspace,
): Promise<void> {
  const current = s.current;
  // The planned command flow always exits at a clean command boundary
  // (auto-snapshot resets `dirty`), so the common case is a clean checkout of
  // `head`. The persisted workspace id is retained in the state file for future
  // multi-workspace support; the manager assigns `ws-<n>` ids itself, so we
  // reuse the constructor-created `current` workspace here.
  if (ws.head !== null && isHash(ws.head)) {
    await current.checkoutId(asSnapshotId(ws.head));
  }
  if (ws.dirty) {
    // Best-effort dirty reconstruction: write each persisted working-tree
    // entry on top of the (possibly empty) checkout. Objects already live in
    // the `FsStore`, so re-writing is idempotent at the store level.
    for (const [path, blobIdHex] of Object.entries(ws.tree)) {
      if (!isHash(blobIdHex)) continue;
      const obj = s.store.getObject(asHash(blobIdHex));
      if (obj.kind === "blob") {
        await current.write(path, new Uint8Array(obj.bytes));
      }
    }
  }
}

/** Re-append a non-pointer op-log event, preserving its original timestamp. */
function reappendEvent(log: OpLog, rec: SerializedOpLogEvent): void {
  const ts = rec.timestamp;
  switch (rec.kind) {
    case "snapshot-create":
      log.append(
        "snapshot-create",
        ts,
        {
          snapshotId: asSnapshotId(rec.snapshotId!),
          parentId: rec.parentId ? asSnapshotId(rec.parentId) : null,
        },
      );
      return;
    case "publish":
      log.append("publish", ts, { snapshotId: asSnapshotId(rec.snapshotId!) });
      return;
    case "unpublish":
      log.append("unpublish", ts, { snapshotId: asSnapshotId(rec.snapshotId!) });
      return;
    default:
      // pointer-move events are regenerated from the maps, not re-appended.
      return;
  }
}

/** Serialize an `OpLogEvent` to a JSON record. */
function serializeEvent(e: OpLogEvent): SerializedOpLogEvent {
  const base = { seq: e.seq, kind: e.kind, timestamp: e.timestamp };
  if (e.kind === "bookmark-move" || e.kind === "tag-move") {
    return { ...base, name: e.name, from: e.from, to: e.to };
  }
  if (e.kind === "snapshot-create") {
    return { ...base, snapshotId: e.snapshotId, parentId: e.parentId };
  }
  // publish / unpublish
  return { ...base, snapshotId: e.snapshotId };
}

// ---------------------------------------------------------------------------
// Factory hook: `CliSession` calls this when a durable root is configured.
// ---------------------------------------------------------------------------

/**
 * The durable factory registered with `session.ts`. When `SESSION_ROOT` is set,
 * `initSession` / `requireSession` call this to create/load a durable session
 * instead of the in-memory default. Registered on import so the dispatcher only
 * needs to import this module once to enable durable backing.
 */
const durableFactory: SessionFactory = {
  async create(root: string): Promise<CliSession> {
    return createDurable(root);
  },
  async loadExisting(root: string): Promise<CliSession | null> {
    return loadDurable(root);
  },
};
registerDurableFactory(durableFactory);
