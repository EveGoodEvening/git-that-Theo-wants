// C7 workspace independence: multiple workspaces over the same store/log,
// independent of ref ownership, with no locking.
//
// Git worktrees fail pain point #5: a worktree checked out to a branch locks
// that branch for other worktrees and can lock out the main directory. The
// prototype instead makes workspaces independent (closer to jj's "repo is the
// source of truth, working copy is just a materialization"):
//
//   - A `Workspace` has a stable `WorkspaceId`, a current snapshot id, and an
//     optional current logical ref pointer (bookmark/tag name). The ref pointer
//     is *not* ownership: it records which named ref the workspace is tracking
//     but does not prevent any other workspace from checking out or moving the
//     same ref. There is no lock state.
//   - A `WorkspaceManager` is a registry of workspaces sharing one store, op-log,
//     and bookmark set. `checkout` of the same snapshot/ref by multiple
//     workspaces is always allowed and never blocks.
//   - Divergence is conflict-as-data (see `conflict.ts`): when two workspaces on
//     the same logical ref produce distinct heads, `diverge` records a
//     resolvable `Conflict` object. No workspace is blocked; no error is thrown.
//
// `WorkingCopy` (C4) is reused unchanged for the in-memory tree + auto-snapshot
// mechanics. `Workspace` composes a `WorkingCopy` and adds identity + the
// ref/snapshot pointers C4 deliberately omits. This file does not edit
// `working-copy.ts`.

import type { SnapshotId } from "../core/ids.ts";
import type { Store } from "../store/store.ts";
import type { OpLog } from "../snapshot/oplog.ts";
import type { Snapshot } from "../snapshot/snapshot.ts";
import { loadSnapshot } from "../snapshot/snapshot.ts";
import type { Bookmarks } from "../snapshot/bookmark.ts";
import {
  type WorkingCopy,
  type WorkingCopyOptions,
  type CommandBoundaryOptions,
  type CommandBoundarySnapshot,
  type RunCommandResult,
  createWorkingCopy,
} from "./working-copy.ts";
import {
  type Conflict,
  type ConflictLog,
  detectDivergence,
} from "./conflict.ts";

/**
 * Opaque workspace identity. A stable, non-empty string assigned at creation.
 * Branded so it cannot be confused with `ActorId` or ref names.
 */
export type WorkspaceId = string & { readonly __brand: "WorkspaceId" };

/** Brand a non-empty string as a `WorkspaceId`. */
export function asWorkspaceId(s: string): WorkspaceId {
  if (s.length === 0) {
    throw new TypeError("WorkspaceId must be a non-empty string");
  }
  return s as WorkspaceId;
}

/** Type guard: true if `v` is a non-empty `WorkspaceId`-shaped string. */
export function isWorkspaceId(v: unknown): v is WorkspaceId {
  return typeof v === "string" && v.length > 0;
}

/**
 * Options for creating a workspace. The `now` clock and `defaultMessage` are
 * forwarded to the underlying `WorkingCopy`.
 */
export interface WorkspaceOptions extends WorkingCopyOptions {
  /**
   * The logical ref (bookmark/tag name) this workspace is attached to, or
   * `null` for an anonymous workspace. The ref pointer records intent only; it
   * is not ownership and does not lock the ref.
   */
  readonly ref?: string | null;
}

/**
 * An independent workspace: a stable id + current snapshot/ref pointers,
 * composing a C4 `WorkingCopy` for the in-memory tree and auto-snapshot
 * mechanics. Workspaces do not lock refs or snapshots; any number may check out
 * the same snapshot/ref concurrently.
 */
export class Workspace {
  private readonly store: Store;
  private readonly log: OpLog;
  private readonly bookmarks: Bookmarks | null;
  readonly id: WorkspaceId;
  private ref_: string | null;
  private readonly workingCopy_: WorkingCopy;

  constructor(
    store: Store,
    log: OpLog,
    id: WorkspaceId,
    options: WorkspaceOptions = {},
    bookmarks: Bookmarks | null = null,
  ) {
    this.store = store;
    this.log = log;
    this.bookmarks = bookmarks;
    this.id = id;
    this.ref_ = options.ref ?? null;
    this.workingCopy_ = createWorkingCopy(store, log, options);
  }

  /** The logical ref (bookmark/tag name) this workspace is attached to, or `null`. */
  get ref(): string | null {
    return this.ref_;
  }

  /** Set the logical ref pointer. Does not lock or move the ref. */
  setRef(ref: string | null): void {
    this.ref_ = ref;
  }

  /** The current base snapshot id, or `null` before the first snapshot. */
  get currentSnapshotId(): SnapshotId | null {
    return this.workingCopy_.currentSnapshotId;
  }

  /** True when the working tree has unsnapshotted mutations. */
  get dirty(): boolean {
    return this.workingCopy_.dirty;
  }

  /** The underlying `WorkingCopy`. Callers may use it directly; it shares state. */
  get workingCopy(): WorkingCopy {
    return this.workingCopy_;
  }

  /**
   * Check out `snapshot` in this workspace. Replaces the working tree and marks
   * it clean. Does not touch any ref pointer or lock. Any number of workspaces
   * may check out the same snapshot concurrently.
   */
  checkout(snapshot: Snapshot): void {
    this.workingCopy_.checkout(snapshot);
  }

  /**
   * Load `id` from the store and check it out in this workspace. Throws
   * `NotFound` (from the store) if the snapshot is missing. No locking.
   */
  async checkoutId(id: SnapshotId): Promise<void> {
    const snapshot = await loadSnapshot(id, this.store);
    this.checkout(snapshot);
  }

  /**
   * Check out the snapshot that bookmark/tag `ref` currently points at. Throws
   * `BookmarkNotFound` (from `Bookmarks`) if the ref does not exist. Does not
   * lock the ref; another workspace may check out or move the same ref freely.
   */
  async checkoutRef(ref: string): Promise<void> {
    if (this.bookmarks === null) {
      throw new TypeError(
        "Workspace.checkoutRef requires a Bookmarks registry",
      );
    }
    const target = this.bookmarks.hasBookmark(ref)
      ? this.bookmarks.getBookmark(ref)
      : this.bookmarks.getTag(ref);
    this.ref_ = ref;
    await this.checkoutId(target);
  }

  /** Read a path from the current working tree through the Store. */
  read(path: string): Uint8Array {
    return this.workingCopy_.read(path);
  }

  /** Write bytes directly into the working tree; there is no staging/index. */
  async write(path: string, bytes: Uint8Array): Promise<void> {
    await this.workingCopy_.write(path, bytes);
  }

  /** Move a path directly in the working tree. */
  move(from: string, to: string): void {
    this.workingCopy_.move(from, to);
  }

  /** Remove a path directly from the working tree. */
  remove(path: string): void {
    this.workingCopy_.remove(path);
  }

  /**
   * Auto-snapshot the dirty working copy at a command boundary. Clean
   * boundaries are no-ops and return `null`. Delegates to the composed
   * `WorkingCopy`.
   */
  async commandBoundary(
    options: CommandBoundaryOptions = {},
  ): Promise<CommandBoundarySnapshot | null> {
    return this.workingCopy_.commandBoundary(options);
  }

  /** Run a command and then apply the command-boundary auto-snapshot rule. */
  async runCommand<T>(
    command: (workspace: Workspace) => T | Promise<T>,
    options: CommandBoundaryOptions = {},
  ): Promise<RunCommandResult<T>> {
    const result = await command(this);
    const boundary = await this.commandBoundary(options);
    return { result, boundary };
  }
}

/**
 * Registry of independent workspaces sharing one store, op-log, and (optional)
 * bookmark set. Creating or checking out a workspace never locks; multiple
 * workspaces may check out the same snapshot/ref concurrently.
 */
export class WorkspaceManager {
  private readonly store: Store;
  private readonly log: OpLog;
  private readonly bookmarks: Bookmarks | null;
  private readonly workspaces = new Map<WorkspaceId, Workspace>();
  private counter = 0;

  constructor(
    store: Store,
    log: OpLog,
    bookmarks: Bookmarks | null = null,
  ) {
    this.store = store;
    this.log = log;
    this.bookmarks = bookmarks;
  }

  /** All workspace ids in insertion order. */
  list(): WorkspaceId[] {
    return Array.from(this.workspaces.keys());
  }

  /** True iff a workspace with `id` is registered. */
  has(id: WorkspaceId): boolean {
    return this.workspaces.has(id);
  }

  /** Get a workspace by id, or `undefined`. */
  get(id: WorkspaceId): Workspace | undefined {
    return this.workspaces.get(id);
  }

  /**
   * Create a new anonymous workspace with a fresh id. The id is deterministic
   * (`ws-<n>`) so tests can refer to it, but it is opaque and unique within this
   * manager. No checkout is performed; the workspace starts empty and clean.
   */
  create(options: WorkspaceOptions = {}): Workspace {
    this.counter += 1;
    const id = asWorkspaceId(`ws-${this.counter}`);
    if (this.workspaces.has(id)) {
      throw new Error(`Workspace id collision: ${id}`);
    }
    const ws = new Workspace(
      this.store,
      this.log,
      id,
      options,
      this.bookmarks,
    );
    this.workspaces.set(id, ws);
    return ws;
  }

  /**
   * Create a new workspace checked out at `snapshot`. Convenience for
   * `create` + `checkout`. No locking: multiple workspaces may check out the
   * same snapshot concurrently.
   */
  createAt(snapshot: Snapshot, options: WorkspaceOptions = {}): Workspace {
    const ws = this.create(options);
    ws.checkout(snapshot);
    return ws;
  }

  /**
   * Create a new workspace checked out at the snapshot `ref` points at. Throws
   * `BookmarkNotFound` if the ref does not exist. No locking: multiple
   * workspaces may check out the same ref concurrently.
   */
  async createAtRef(ref: string, options: WorkspaceOptions = {}): Promise<Workspace> {
    const ws = this.create({ ...options, ref });
    await ws.checkoutRef(ref);
    return ws;
  }

  /** Remove a workspace from the registry. No-op if not registered. */
  remove(id: WorkspaceId): void {
    this.workspaces.delete(id);
  }
}

/**
 * Detect and record divergence between two workspaces on the same logical ref.
 * Both workspaces must share a common `base` snapshot id; if their current
 * snapshot ids differ, a `Conflict` is built and recorded in `log`. Returns the
 * recorded conflict, or `null` if there is no divergence (same head) or no
 * shared base. Never throws — divergence is conflict-as-data, not a lock error.
 *
 * `ref` defaults to the shared ref name when both workspaces report the same
 * non-null ref, otherwise the caller should supply the logical ref explicitly.
 */
export async function diverge(
  log: ConflictLog,
  left: Workspace,
  right: Workspace,
  base: SnapshotId,
  timestamp: number,
  ref?: string,
): Promise<Conflict | null> {
  const leftHead = left.currentSnapshotId;
  const rightHead = right.currentSnapshotId;
  if (leftHead === null || rightHead === null) {
    return null;
  }
  const refName =
    ref ??
    (left.ref !== null && left.ref === right.ref ? left.ref : "");
  return detectDivergence(
    log,
    refName,
    base,
    left.id,
    leftHead,
    right.id,
    rightHead,
    timestamp,
  );
}

/** Re-export the conflict-as-data types for workspace consumers. */
export type { Conflict, ConflictId, ConflictLog } from "./conflict.ts";
