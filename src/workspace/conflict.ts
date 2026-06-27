// C7 conflict-as-data: divergence between workspaces produces a resolvable
// conflict object, never a lock error.
//
// Git worktrees fail pain point #5: a worktree checked out to a branch locks
// that branch for other worktrees. The prototype instead makes workspaces
// independent of ref ownership (closer to jj's "repo is the source of truth,
// working copy is just a materialization"). When two workspaces diverge on the
// same logical ref, the divergence is recorded as a `Conflict` value — a plain
// data object carrying the base snapshot and both divergent heads — which a
// caller can resolve explicitly. No workspace is ever blocked from checking out
// or mutating because another workspace holds the same ref.
//
// A `Conflict` is content-addressed by its inputs (ref name, base, left, right,
// workspace ids) so the same divergence is idempotent. A `ConflictLog` collects
// conflicts as data; it never throws and never prevents further mutations.

import type { Hash } from "../core/ids.ts";
import {
  concat,
  frameString,
  sha256,
} from "../core/ids.ts";
import type { SnapshotId } from "../core/ids.ts";

/**
 * Opaque content-addressed identity for a `Conflict`. Branded hex string so it
 * cannot be confused with a `SnapshotId` or `Hash` at the type level.
 */
export type ConflictId = string & { readonly __brand: "ConflictId" };

/** Brand a valid 64-char lowercase hex string as a `ConflictId`. */
export function asConflictId(hex: string): ConflictId {
  if (hex.length !== 64 || !/^[0-9a-f]+$/.test(hex)) {
    throw new TypeError(`Invalid ConflictId (expected SHA-256 hex): ${hex}`);
  }
  return hex as ConflictId;
}

/** Type guard: true if `v` is a 64-char lowercase hex `ConflictId`. */
export function isConflictId(v: unknown): v is ConflictId {
  return typeof v === "string" && v.length === 64 && /^[0-9a-f]+$/.test(v);
}

/**
 * A resolvable conflict-as-data object. Records that two workspaces diverged on
 * the same logical ref: both started at `base` and produced distinct heads
 * `left` and `right`. The conflict is content-addressed by its inputs; the same
 * divergence yields the same `id` (idempotent). `resolution` is `null` until a
 * caller explicitly resolves it.
 */
export interface Conflict {
  /** Content-addressed identity computed over the conflict inputs. */
  readonly id: ConflictId;
  /** The logical ref name the divergence occurred on (bookmark/tag name). */
  readonly ref: string;
  /** The common base snapshot id both workspaces started from. */
  readonly base: SnapshotId;
  /** The divergent head produced by `leftWorkspace`. */
  readonly left: SnapshotId;
  /** The divergent head produced by `rightWorkspace`. */
  readonly right: SnapshotId;
  /** The workspace id that produced `left`. */
  readonly leftWorkspace: string;
  /** The workspace id that produced `right`. */
  readonly rightWorkspace: string;
  /** Timestamp (ms since epoch, or any monotonic integer) of detection. */
  readonly timestamp: number;
  /** Resolved snapshot id, or `null` until explicitly resolved. */
  readonly resolution: SnapshotId | null;
}

/**
 * Compute a deterministic `ConflictId` over the conflict inputs. The id is the
 * SHA-256 of the framed fields (ref, base, left, right, workspace ids), so the
 * same divergence is idempotent regardless of detection order or time. Swapping
 * left/right (with their workspace ids) produces a different id, preserving the
 * identity of which workspace produced which head. The `timestamp` is excluded
 * from the hash: it is a detection-time observation, not part of the divergence
 * identity, so the same divergence recorded at different times yields the same
 * `ConflictId`.
 */
export async function computeConflictId(
  ref: string,
  base: SnapshotId,
  left: SnapshotId,
  right: SnapshotId,
  leftWorkspace: string,
  rightWorkspace: string,
): Promise<ConflictId> {
  const framed = concat([
    frameString("ref", ref),
    frameString("base", base),
    frameString("left", left),
    frameString("right", right),
    frameString("left-ws", leftWorkspace),
    frameString("right-ws", rightWorkspace),
  ]);
  return asConflictId((await sha256(framed)) as string as ConflictId);
}

/**
 * Build a `Conflict` value from a divergence. The `id` is computed from the
 * inputs; `resolution` starts as `null`. This is pure data — it never throws
 * and never blocks either workspace.
 */
export async function createConflict(
  ref: string,
  base: SnapshotId,
  left: SnapshotId,
  right: SnapshotId,
  leftWorkspace: string,
  rightWorkspace: string,
  timestamp: number,
): Promise<Conflict> {
  const id = await computeConflictId(
    ref,
    base,
    left,
    right,
    leftWorkspace,
    rightWorkspace,
  );
  return {
    id,
    ref,
    base,
    left,
    right,
    leftWorkspace,
    rightWorkspace,
    timestamp,
    resolution: null,
  };
}

/**
 * Return a new `Conflict` with `resolution` set to `resolvedSnapshotId`. The
 * conflict remains in the log as data; resolution is an explicit, auditable
 * transition, not a deletion. The `id` is preserved so the resolved record is
 * the same logical object.
 */
export function resolveConflict(
  conflict: Conflict,
  resolvedSnapshotId: SnapshotId,
): Conflict {
  return { ...conflict, resolution: resolvedSnapshotId };
}

/**
 * Append-only collection of `Conflict` values. Conflicts are stored as data,
 * never thrown. Recording a conflict with an `id` already in the log is an
 * idempotent no-op (the same divergence is recorded once). Resolution updates
 * the stored record in place by `id`.
 */
export class ConflictLog {
  private readonly conflicts = new Map<ConflictId, Conflict>();

  /** Record a conflict. Idempotent on `id`: a repeat returns the stored value. */
  record(conflict: Conflict): Conflict {
    const existing = this.conflicts.get(conflict.id);
    if (existing !== undefined) {
      return existing;
    }
    this.conflicts.set(conflict.id, conflict);
    return conflict;
  }

  /** Get a conflict by id, or `undefined`. */
  get(id: ConflictId): Conflict | undefined {
    return this.conflicts.get(id);
  }

  /** True iff a conflict with `id` is recorded. */
  has(id: ConflictId): boolean {
    return this.conflicts.has(id);
  }

  /**
   * Mark a recorded conflict resolved by setting its `resolution`. Returns the
   * updated conflict, or `undefined` if the conflict is not recorded. Does not
   * throw on a missing id — resolution is best-effort data.
   */
  resolve(id: ConflictId, resolvedSnapshotId: SnapshotId): Conflict | undefined {
    const existing = this.conflicts.get(id);
    if (existing === undefined) {
      return undefined;
    }
    const resolved = resolveConflict(existing, resolvedSnapshotId);
    this.conflicts.set(id, resolved);
    return resolved;
  }

  /** All recorded conflicts in insertion order. */
  list(): Conflict[] {
    return Array.from(this.conflicts.values());
  }

  /** All *unresolved* conflicts (resolution === null) in insertion order. */
  unresolved(): Conflict[] {
    return this.list().filter((c) => c.resolution === null);
  }

  /** Conflicts recorded against a given `ref` name, in insertion order. */
  forRef(ref: string): Conflict[] {
    return this.list().filter((c) => c.ref === ref);
  }
}

/**
 * Detect divergence between two non-null workspace heads on the same logical ref.
 * A conflict is recorded only when the heads differ from each other and both
 * differ from the shared `base`. Returns the recorded conflict, or `null` when
 * either head is still at `base` or both heads are the same. Never throws.
 *
 * `ref` is the logical ref name the workspaces are attached to (may be empty
 * for anonymous divergence). The two workspace ids and their current snapshot
 * ids are the divergent heads.
 */
export async function detectDivergence(
  log: ConflictLog,
  ref: string,
  base: SnapshotId,
  leftWorkspace: string,
  leftHead: SnapshotId,
  rightWorkspace: string,
  rightHead: SnapshotId,
  timestamp: number,
): Promise<Conflict | null> {
  if (leftHead === rightHead || leftHead === base || rightHead === base) {
    return null;
  }
  const conflict = await createConflict(
    ref,
    base,
    leftHead,
    rightHead,
    leftWorkspace,
    rightWorkspace,
    timestamp,
  );
  return log.record(conflict);
}

// Suppress unused-import lint for the `Hash` type re-asserted at runtime
// boundaries (kept for future manifest-ref-aware conflict extensions).
void (undefined as unknown as Hash);
