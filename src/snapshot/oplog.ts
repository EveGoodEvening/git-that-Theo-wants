// C4 operation log: an append-only event log replacing git's reflog.
//
// The op-log records every operation that mutates repository state — bookmark
// and tag moves, snapshot creation, visibility transitions (C6), etc. It is
// strictly append-only: a move never rewrites a previous entry, it appends a
// new event. This makes the history of pointer moves recoverable and auditable,
// and supports jj-style undo (a future chunk) by replaying the log.
//
// Events are plain immutable records; the log itself is a grow-only array. The
// log carries a monotonic sequence number per event so ordering is stable even
// if events are read in bulk.

import type { Hash, SnapshotId } from "../core/ids.ts";

/** Monotonic op-log sequence number (1-indexed). */
export type OpSeq = number & { readonly __brand: "OpSeq" };

/** Kind tag for an op-log event. */
export type OpKind =
  | "bookmark-move"
  | "tag-move"
  | "snapshot-create"
  | "publish"
  | "unpublish";

/** Common fields on every op-log event. */
export interface OpLogEventBase {
  /** Monotonic sequence number (1-indexed, assigned on append). */
  readonly seq: OpSeq;
  /** Kind tag. */
  readonly kind: OpKind;
  /** Wall-clock timestamp (ms since epoch) at append time. */
  readonly timestamp: number;
}

/** A bookmark or tag move event: `from` is `null` for a creation. */
export interface PointerMoveEvent extends OpLogEventBase {
  readonly kind: "bookmark-move" | "tag-move";
  /** Bookmark/tag name. */
  readonly name: string;
  /** Previous target, or `null` if this is a creation. */
  readonly from: SnapshotId | null;
  /** New target. */
  readonly to: SnapshotId;
}

/** A snapshot-create event. */
export interface SnapshotCreateEvent extends OpLogEventBase {
  readonly kind: "snapshot-create";
  /** The created snapshot id. */
  readonly snapshotId: SnapshotId;
  /** Parent snapshot id, or `null` for a root. */
  readonly parentId: SnapshotId | null;
}

/** A publish/unpublish visibility transition event (C6 populates detail). */
export interface VisibilityEvent extends OpLogEventBase {
  readonly kind: "publish" | "unpublish";
  /** The snapshot whose visibility changed. */
  readonly snapshotId: SnapshotId;
}

/** An op-log event. Discriminated union on `kind`. */
export type OpLogEvent =
  | PointerMoveEvent
  | SnapshotCreateEvent
  | VisibilityEvent;

/**
 * Append-only operation log. Events are immutable once appended; the log never
 * rewrites or removes entries. `seq` numbers are assigned monotonically on
 * append.
 */
export class OpLog {
  private readonly events: OpLogEvent[] = [];
  private nextSeq = 1;

  /** All events in append order. Returns a defensive copy. */
  list(): OpLogEvent[] {
    return this.events.slice();
  }

  /** Number of events appended. */
  get length(): number {
    return this.events.length;
  }

  /** Event at `seq` (1-indexed), or `undefined`. */
  at(seq: OpSeq): OpLogEvent | undefined {
    return this.events[seq - 1];
  }

  /**
   * Append an event body (without `seq`/`timestamp`) and return the full
   * recorded event with `seq` and `timestamp` filled in. Internal: callers use
   * the typed `append*` helpers below.
   */
  append(
    kind: OpKind,
    timestamp: number,
    body: Omit<OpLogEvent, "seq" | "kind" | "timestamp">,
  ): OpLogEvent {
    const seq = this.nextSeq as OpSeq;
    this.nextSeq++;
    const event = Object.freeze({
      seq,
      kind,
      timestamp,
      ...body,
    } as OpLogEvent);
    this.events.push(event);
    return event;
  }
}

/** Append a bookmark-move event. `from` is `null` for a creation. */
export function appendBookmarkMove(
  log: OpLog,
  move: {
    name: string;
    from: SnapshotId | null;
    to: SnapshotId;
  },
  timestamp: number = Date.now(),
): PointerMoveEvent {
  return log.append("bookmark-move", timestamp, move) as PointerMoveEvent;
}

/** Append a tag-move event. `from` is `null` for a creation. */
export function appendTagMove(
  log: OpLog,
  move: {
    name: string;
    from: SnapshotId | null;
    to: SnapshotId;
  },
  timestamp: number = Date.now(),
): PointerMoveEvent {
  return log.append("tag-move", timestamp, move) as PointerMoveEvent;
}

/** Append a snapshot-create event. */
export function appendSnapshotCreate(
  log: OpLog,
  ev: {
    snapshotId: SnapshotId;
    parentId: SnapshotId | null;
  },
  timestamp: number = Date.now(),
): SnapshotCreateEvent {
  return log.append("snapshot-create", timestamp, ev) as SnapshotCreateEvent;
}

/** Append a publish visibility-transition event. */
export function appendPublish(
  log: OpLog,
  ev: { snapshotId: SnapshotId },
  timestamp: number = Date.now(),
): VisibilityEvent {
  return log.append("publish", timestamp, ev) as VisibilityEvent;
}

/** Append an unpublish visibility-transition event. */
export function appendUnpublish(
  log: OpLog,
  ev: { snapshotId: SnapshotId },
  timestamp: number = Date.now(),
): VisibilityEvent {
  return log.append("unpublish", timestamp, ev) as VisibilityEvent;
}

// Suppress unused-import lint for types re-asserted at runtime boundaries.
void (undefined as unknown as Hash);
