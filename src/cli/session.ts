// C9 CLI session: assembles the in-memory demo store state the thin CLI
// commands delegate to.
//
// The CLI is deliberately thin (plan C9: "no business logic in commands"). All
// repository state — the `Store`, the append-only `OpLog`, the `Bookmarks`
// registry, the `VisibilityLog` replayed from the op-log, the
// `WorkspaceManager`, and the per-snapshot/per-path visibility tables — lives
// here in a `CliSession`. Command functions in `commands.ts` read and mutate
// this session through the existing core/vfs/snapshot/policy/workspace/fs
// APIs; they never re-implement that logic.
//
// Per plan §5 there is no `fetch`/network transfer and no persistent server:
// the session is an in-memory, single-process simulation. `init` creates a
// fresh session; subsequent commands in the same process invocation share it.
// The session also tracks the per-snapshot `SnapshotVisibility` (snapshot
// state + per-path overrides) that C6's `derivePublicProjection` consumes.

import { MemoryStore } from "../store/memory-store.ts";
import type { Store } from "../store/store.ts";
import { OpLog } from "../snapshot/oplog.ts";
import { Bookmarks } from "../snapshot/bookmark.ts";
import {
  VisibilityLog,
  replayVisibilityLog,
  DEFAULT_VISIBILITY,
} from "../policy/transitions.ts";
import type { VisibilityState } from "../policy/visibility.ts";
import { WorkspaceManager } from "../workspace/workspace.ts";
import type { Workspace } from "../workspace/workspace.ts";
import { type SnapshotId, isHash } from "../core/ids.ts";
import type { SnapshotVisibility } from "../export/public-manifest.ts";

/**
 * Factory that creates a `CliSession` for a durable root directory. Registered
 * by `durable.ts` and invoked by `initSession` / `requireSession` when
 * `SESSION_ROOT` is set, so the dispatcher can switch the CLI between the
 * in-memory default (direct handler tests) and the on-disk backing (real
 * subprocess invocations) without the commands knowing which is active.
 */
export interface SessionFactory {
  /** Create a fresh session at `root` (the `init` command). */
  create(root: string): Promise<CliSession>;
  /**
   * Load an existing durable session at `root`, or return `null` if no session
   * was ever initialized there (no state file). Used by `requireSession` so a
   * `gtw <cmd>` before `gtw init` errors instead of silently creating state.
   */
  loadExisting(root: string): Promise<CliSession | null>;
}

/**
 * Optional durable-session factory. Set by `durable.ts` when the durable CLI
 * state module is loaded. When `SESSION_ROOT` is non-null, `initSession` /
 * `requireSession` delegate to this factory to build/load a session backed by
 * an `FsStore` at `SESSION_ROOT` plus the small JSON state files under
 * `<root>/cli/`. `null` keeps the original in-memory behavior.
 */
let durableFactory: SessionFactory | null = null;

/** Register the durable-session factory (called by `durable.ts` on import). */
export function registerDurableFactory(factory: SessionFactory): void {
  durableFactory = factory;
}

/**
 * The durable root directory for the active session, or `null` for the
 * in-memory default. Set by the dispatcher from the global `--root <dir>` flag
 * (or the `.gtw` default in `cwd`) before a command runs. Direct handler tests
 * leave this `null` and exercise the in-memory session as before.
 */
let SESSION_ROOT: string | null = null;

/** Set the durable root used by `initSession` / `requireSession`. */
export function setSessionRoot(root: string | null): void {
  SESSION_ROOT = root;
}

/**
 * The assembled in-memory demo state the CLI commands operate on. A thin
 * facade over the core APIs — it holds the long-lived objects (store, op-log,
 * bookmarks, workspace manager) and the per-snapshot visibility tables C6's
 * public-projection derivation needs, plus the "current" workspace the
 * working-copy commands (`status`, `snapshot create`, `restore`) act on.
 */
export class CliSession {
  readonly store: Store;
  readonly log: OpLog;
  readonly bookmarks: Bookmarks;
  readonly workspaces: WorkspaceManager;
  /** Per-snapshot visibility state (file/snapshot level). */
  private readonly snapshotStates = new Map<SnapshotId, VisibilityState>();
  /** Per-snapshot per-path visibility overrides. */
  private readonly pathStates = new Map<
    SnapshotId,
    Map<string, VisibilityState>
  >();
  /** The workspace working-copy commands act on. */
  current: Workspace;
  /** Optional real-FS export root (set by `init --fs <dir>` / `export --to`). */
  fsRoot: string | null = null;

  constructor(
    store: Store = new MemoryStore(),
    log: OpLog = new OpLog(),
    bookmarks: Bookmarks = new Bookmarks(log),
    workspaces: WorkspaceManager = new WorkspaceManager(store, log, bookmarks),
  ) {
    this.store = store;
    this.log = log;
    this.bookmarks = bookmarks;
    this.workspaces = workspaces;
    this.current = this.workspaces.create();
  }

  // --- Visibility table helpers (delegation to C6 `SnapshotVisibility`) ----

  /**
   * Set the snapshot-level **initial** visibility for `id`. This is the
   * pre-publish state (private/embargoed/local-only); `public` is rejected
   * because `public` is reachable only via a `publish` op-log event. The
   * effective visibility is the op-log replay (see `visibilityFor`), so a
   * later `publish`/`unpublish` overrides this initial state.
   */
  setSnapshotVisibility(id: SnapshotId, state: VisibilityState): void {
    if (state === "public") {
      throw new CliError(
        "setSnapshotVisibility: public is reachable only via 'gtw publish'",
      );
    }
    this.snapshotStates.set(id, state);
  }

  /** Set a per-path visibility override for `id` at `path`. */
  setPathVisibility(
    id: SnapshotId,
    path: string,
    state: VisibilityState,
  ): void {
    let m = this.pathStates.get(id);
    if (m === undefined) {
      m = new Map<string, VisibilityState>();
      this.pathStates.set(id, m);
    }
    m.set(path, state);
  }

  /**
   * Resolve a snapshot id argument (full 64-char hex or a unique short prefix)
   * to a full `SnapshotId` stored in the session's store. Subprocess CLI
   * invocations only print short id prefixes, so later commands must accept
   * those prefixes and expand them. Throws `CliError` if the prefix is
   * ambiguous, malformed, or matches no stored snapshot.
   */
  resolveSnapshotId(arg: string): SnapshotId {
    if (isHash(arg)) return arg as SnapshotId;
    if (!/^[0-9a-f]+$/.test(arg)) {
      throw new CliError(`invalid snapshot id: ${arg}`);
    }
    const ids = this.store.listSnapshots().filter((id) => id.startsWith(arg));
    if (ids.length === 0) {
      throw new CliError(`no snapshot matching id: ${arg}`);
    }
    if (ids.length > 1) {
      throw new CliError(`ambiguous snapshot id: ${arg}`);
    }
    return ids[0]!;
  }

  /**
   * The effective `SnapshotVisibility` for `id`: the op-log replayed state
   * (publish/unpublish events applied on top of the durable initial states),
   * plus any per-path overrides. This is what C6's `derivePublicProjection`
   * consumes.
   */
  visibilityFor(id: SnapshotId): SnapshotVisibility {
    const state = this.visibilityLog().get(id);
    const pathStates = this.pathStates.get(id);
    return pathStates === undefined
      ? { state }
      : { state, pathStates };
  }

  /** A `Map` view of all recorded per-snapshot visibility, for derivation. */
  visibilityMap(): Map<SnapshotId, SnapshotVisibility> {
    const out = new Map<SnapshotId, SnapshotVisibility>();
    // Include every snapshot that has an initial state or a per-path override.
    const ids = new Set<SnapshotId>(this.snapshotStates.keys());
    for (const id of this.pathStates.keys()) ids.add(id);
    for (const id of ids) out.set(id, this.visibilityFor(id));
    return out;
  }

  /**
   * The `VisibilityLog` replayed from the op-log's publish/unpublish events,
   * seeded with the durable non-public initial states. This is what
   * `publish`/`unpublish` mutate and what `publish-check` reads.
   */
  visibilityLog(): VisibilityLog {
    return replayVisibilityLog(this.log, this.snapshotStates);
  }

  // --- Durable-state accessors (used by `durable.ts` save/load) ---

  /** All recorded per-snapshot non-public initial visibility states. */
  snapshotStatesRecord(): Record<string, VisibilityState> {
    const out: Record<string, VisibilityState> = {};
    for (const [id, state] of this.snapshotStates) out[id] = state;
    return out;
  }

  /** All recorded per-snapshot per-path visibility overrides. */
  pathStatesRecord(): Record<string, Record<string, VisibilityState>> {
    const out: Record<string, Record<string, VisibilityState>> = {};
    for (const [id, paths] of this.pathStates) {
      const inner: Record<string, VisibilityState> = {};
      for (const [path, state] of paths) inner[path] = state;
      out[id] = inner;
    }
    return out;
  }
}

/**
 * The process-wide session used by the CLI dispatcher. `init` resets it; all
 * other commands share it. `null` before `init`.
 */
let SESSION: CliSession | null = null;

/**
 * Create and install a fresh session (the `init` command). When a durable root
 * is configured (`SESSION_ROOT`), the session is created/loaded through the
 * durable factory so it persists across invocations; otherwise an in-memory
 * session is created as before.
 */
export async function initSession(): Promise<CliSession> {
  if (SESSION_ROOT !== null && durableFactory !== null) {
    SESSION = await durableFactory.create(SESSION_ROOT);
    return SESSION;
  }
  SESSION = new CliSession();
  return SESSION;
}

/** The active session, or `null` before `init`. */
export function getSession(): CliSession | null {
  return SESSION;
}

/**
 * Require the active session, throwing a typed error if `init` was not run.
 * When a durable root is configured and no session is installed yet, this
 * loads the durable session from disk so a `gtw <cmd>` invocation after a
 * prior `gtw init` works without re-running `init`.
 */
export async function requireSession(): Promise<CliSession> {
  if (SESSION === null && SESSION_ROOT !== null && durableFactory !== null) {
    const loaded = await durableFactory.loadExisting(SESSION_ROOT);
    if (loaded === null) {
      throw new CliError("no gtw session: run 'gtw init' first");
    }
    SESSION = loaded;
    return SESSION;
  }
  if (SESSION === null) {
    throw new CliError("no gtw session: run 'gtw init' first");
  }
  return SESSION;
}

/** Flush the active session to disk if it is durable (no-op for in-memory). */
export async function saveSession(): Promise<void> {
  if (SESSION !== null && typeof (SESSION as { save?: () => void }).save === "function") {
    (SESSION as { save: () => void }).save();
  }
}

/** Typed CLI error: a user-facing failure with a stable exit code. */
export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}
