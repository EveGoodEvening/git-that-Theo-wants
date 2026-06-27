// C4 working-copy-as-snapshot model (JJ-style).
//
// The working copy is an in-memory C3 `VirtualTree` plus a parent snapshot id.
// Mutating operations update the tree directly: there is no index/staging area
// and no current branch pointer. At a command boundary the dirty working copy is
// wrapped in a C4 `Snapshot`, saved through the Store, and recorded in the
// append-only op-log. Clean boundaries are no-ops.

import type { SnapshotId } from "../core/ids.ts";
import type { Store } from "../store/store.ts";
import type { Snapshot } from "../snapshot/snapshot.ts";
import {
  createSnapshot,
  loadSnapshot,
  saveSnapshot,
} from "../snapshot/snapshot.ts";
import type { OpLog, SnapshotCreateEvent } from "../snapshot/oplog.ts";
import { appendSnapshotCreate } from "../snapshot/oplog.ts";
import type { VirtualTree } from "../vfs/vfs.ts";
import { emptyTree, makeTree } from "../vfs/vfs.ts";
import {
  move as movePath,
  read as readPath,
  remove as removePath,
  write as writePath,
} from "../vfs/ops.ts";

export interface WorkingCopyOptions {
  /** Clock used for auto-snapshot timestamps. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Message used when a command boundary does not supply one. */
  readonly defaultMessage?: string;
}

export interface CommandBoundaryOptions {
  /** Snapshot message for this command boundary. */
  readonly message?: string;
  /** Explicit timestamp for deterministic callers/tests. Defaults to `now()`. */
  readonly timestamp?: number;
  /** Immutable marker; auto-snapshots default to mutable/squashable. */
  readonly immutable?: boolean;
}

export interface CommandBoundarySnapshot {
  /** The auto-created snapshot for this dirty boundary. */
  readonly snapshot: Snapshot;
  /** The op-log event recording the snapshot creation. */
  readonly event: SnapshotCreateEvent;
}

export interface RunCommandResult<T> {
  /** Value returned by the command callback. */
  readonly result: T;
  /** Created snapshot/event, or `null` when the boundary was clean. */
  readonly boundary: CommandBoundarySnapshot | null;
}

/**
 * Minimal JJ-style working copy: direct tree mutations, dirty auto-snapshot at
 * command boundary, no staging/index, and no current-branch state.
 */
export class WorkingCopy {
  private readonly store: Store;
  private readonly log: OpLog;
  private readonly now: () => number;
  private readonly defaultMessage: string;
  private tree_: VirtualTree;
  private currentSnapshotId_: SnapshotId | null;
  private dirty_ = false;

  constructor(
    store: Store,
    log: OpLog,
    options: WorkingCopyOptions = {},
  ) {
    this.store = store;
    this.log = log;
    this.now = options.now ?? Date.now;
    this.defaultMessage = options.defaultMessage ?? "working copy";
    this.tree_ = emptyTree(null);
    this.currentSnapshotId_ = null;
  }

  /** Create a clean working copy checked out at `snapshot`. */
  static fromSnapshot(
    store: Store,
    log: OpLog,
    snapshot: Snapshot,
    options: WorkingCopyOptions = {},
  ): WorkingCopy {
    const wc = new WorkingCopy(store, log, options);
    wc.checkout(snapshot);
    return wc;
  }

  /** Load `id` from `store` and create a clean working copy checked out there. */
  static async load(
    store: Store,
    log: OpLog,
    id: SnapshotId,
    options: WorkingCopyOptions = {},
  ): Promise<WorkingCopy> {
    const snapshot = await loadSnapshot(id, store);
    return WorkingCopy.fromSnapshot(store, log, snapshot, options);
  }

  /** The current base snapshot id, or `null` before the first snapshot. */
  get currentSnapshotId(): SnapshotId | null {
    return this.currentSnapshotId_;
  }

  /** True when the tree has unsnapshotted mutations. */
  get dirty(): boolean {
    return this.dirty_;
  }

  /** A defensive copy of the current tree; callers cannot mutate internal state. */
  get tree(): VirtualTree {
    return makeTree(this.tree_.parentId, this.tree_.entries);
  }

  /** Read a path from the current working tree through the Store. */
  read(path: string): Uint8Array {
    return readPath(this.tree_, path, this.store);
  }

  /** Write bytes directly into the working tree; there is no staging/index. */
  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.tree_ = await writePath(this.tree_, path, bytes, this.store);
    this.dirty_ = true;
  }

  /** Move a path directly in the working tree. */
  move(from: string, to: string): void {
    this.tree_ = movePath(this.tree_, from, to);
    this.dirty_ = true;
  }

  /** Remove a path directly from the working tree. */
  remove(path: string): void {
    this.tree_ = removePath(this.tree_, path);
    this.dirty_ = true;
  }

  /**
   * Replace the current working tree with `snapshot` and mark it clean. This is
   * a checkout of a snapshot id only; it does not create or update any branch.
   */
  checkout(snapshot: Snapshot): void {
    this.currentSnapshotId_ = snapshot.id;
    this.tree_ = makeTree(snapshot.id, snapshot.tree);
    this.dirty_ = false;
  }

  /**
   * Auto-snapshot the dirty working copy at a command boundary. Clean
   * boundaries are no-ops and return `null`.
   */
  async commandBoundary(
    options: CommandBoundaryOptions = {},
  ): Promise<CommandBoundarySnapshot | null> {
    if (!this.dirty_) {
      return null;
    }

    const parentId = this.currentSnapshotId_;
    const timestamp = options.timestamp ?? this.now();
    const snapshot = await createSnapshot(
      parentId,
      this.tree_.entries,
      timestamp,
      options.message ?? this.defaultMessage,
      options.immutable ?? false,
    );

    saveSnapshot(snapshot, this.store);
    const event = appendSnapshotCreate(
      this.log,
      { snapshotId: snapshot.id, parentId },
      timestamp,
    );

    this.currentSnapshotId_ = snapshot.id;
    this.tree_ = makeTree(snapshot.id, snapshot.tree);
    this.dirty_ = false;

    return { snapshot, event };
  }

  /** Run a command and then apply the command-boundary auto-snapshot rule. */
  async runCommand<T>(
    command: (workingCopy: WorkingCopy) => T | Promise<T>,
    options: CommandBoundaryOptions = {},
  ): Promise<RunCommandResult<T>> {
    const result = await command(this);
    const boundary = await this.commandBoundary(options);
    return { result, boundary };
  }
}

/** Create an empty working copy with no current branch or index. */
export function createWorkingCopy(
  store: Store,
  log: OpLog,
  options: WorkingCopyOptions = {},
): WorkingCopy {
  return new WorkingCopy(store, log, options);
}

/** Create a clean working copy checked out at `snapshot`. */
export function checkoutWorkingCopy(
  store: Store,
  log: OpLog,
  snapshot: Snapshot,
  options: WorkingCopyOptions = {},
): WorkingCopy {
  return WorkingCopy.fromSnapshot(store, log, snapshot, options);
}
