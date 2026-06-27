// C6 visibility transitions: publish and unpublish as op-log events.
//
// Per plan §2 decision 7, `publish` is recorded as an op-log event and is
// irreversible; a later `unpublish` (re-privatization) is a **new** op-log
// event that flips the snapshot's visibility back to `private` for *future*
// readers. It cannot recall content already fetched/exported by a public peer
// (same best-effort limit as revocation). The op-log stays append-only.
//
// There is no time side channel: `embargoed` only becomes `public` via an
// explicit `publish` event, never via a clock advance.
//
// This module owns the visibility-state bookkeeping that the op-log records. It
// does not edit C4-owned files; it consumes `OpLog`/`appendPublish`/
// `appendUnpublish` from `src/snapshot/oplog.ts` and tracks the current
// visibility of each `SnapshotId` in a `VisibilityLog` (a deterministic
// replay of the op-log's visibility events).
//
// Mutation invariant (C6 review): the `public` state is reachable ONLY through
// `publish()` (which appends a `publish` op-log event), and the `private`
// state is reachable from `public` ONLY through `unpublish()` (which appends an
// `unpublish` op-log event). `VisibilityLog` exposes no public arbitrary-state
// setter: its mutation methods are module-private, gated by an unexported
// `INTERNAL_TOKEN` so external callers cannot bypass the op-log. The exported
// `setVisibility` is restricted to **non-public initial states** and rejected
// once a snapshot is `public` (leaving `public` requires `unpublish`) AND once
// a snapshot has any prior publish/unpublish transition history (tracked in
// `VisibilityLog.transitioned`), so an initial seed cannot override recorded
// transition history — even after an `unpublish` returns the current state to
// `private`.

import type { SnapshotId } from "../core/ids.ts";
import {
  type OpLog,
  appendPublish,
  appendUnpublish,
} from "../snapshot/oplog.ts";
import {
  type VisibilityState,
  publishTarget,
  unpublishTarget,
} from "./visibility.ts";

/**
 * A snapshot's visibility at a given op-log sequence. The default visibility for
 * a newly created snapshot is `private` (plan: a private PR is the starting
 * state; `publish` flips it to public). `local-only` and `embargoed` are set
 * explicitly by the owner before a publish.
 */
export const DEFAULT_VISIBILITY: VisibilityState = "private";

/**
 * Module-private token gating `VisibilityLog`'s mutation methods. It is NOT
 * exported, so external callers cannot construct a value of type
 * `typeof INTERNAL_TOKEN` (a `unique symbol`) and thus cannot invoke
 * `applyPublish`/`applyUnpublish`/`applyInitial` directly. Only this module's
 * `publish`/`unpublish`/`replayVisibilityLog`/`setVisibility` functions — which
 * enforce the op-log invariants — may mutate the log.
 */
const INTERNAL_TOKEN: unique symbol = Symbol("VisibilityLog.internal");

/**
 * A deterministic map of `SnapshotId -> VisibilityState`, replayed from the
 * op-log's visibility events. This is the authoritative current-visibility view
 * for authorization checks: a snapshot's visibility is whatever the latest
 * visibility event for that id says, or `DEFAULT_VISIBILITY` if none.
 *
 * The map is mutable (upserted on each transition) but every mutation is backed
 * by an appended op-log event (or, for pre-publish initial states, is a
 * non-public assignment that cannot reach `public`), so the history is
 * recoverable and auditable. There is NO public arbitrary-state setter: the
 * `public` state is reachable only via `publish()` and the `private`-from-
 * `public` transition only via `unpublish()`.
 */
export class VisibilityLog {
  private readonly states = new Map<SnapshotId, VisibilityState>();
  /**
   * Snapshots that have had at least one publish/unpublish transition applied.
   * Once transitioned, an initial (pre-publish) state assignment is permanently
   * rejected — even after a later `unpublish` returns the current state to
   * `private`, the snapshot has a transition history and may not be re-seeded
   * as if it were a fresh pre-publish snapshot. This prevents a `local-only`
   * post-transition seed from overriding recorded transition history.
   */
  private readonly transitioned = new Set<SnapshotId>();

  /** The current visibility for `id`, or `DEFAULT_VISIBILITY` if unset. */
  get(id: SnapshotId): VisibilityState {
    return this.states.get(id) ?? DEFAULT_VISIBILITY;
  }

  /** Whether a visibility has been explicitly recorded for `id`. */
  has(id: SnapshotId): boolean {
    return this.states.has(id);
  }

  /**
   * Whether `id` has any recorded publish/unpublish transition history. Once
   * true, `applyInitial` rejects for `id` regardless of its current state.
   */
  hasTransitioned(id: SnapshotId): boolean {
    return this.transitioned.has(id);
  }

  /**
   * @internal Apply a recorded `publish` event's effect: set `id` to `public`.
   * Module-private via `INTERNAL_TOKEN`; external callers cannot satisfy the
   * token type. The caller (`publish`/`replayVisibilityLog`) is responsible for
   * having appended (or replayed) the corresponding op-log event.
   */
  applyPublish(id: SnapshotId, token: typeof INTERNAL_TOKEN): void {
    if (token !== INTERNAL_TOKEN) {
      throw new Error("VisibilityLog.applyPublish: internal token required");
    }
    this.states.set(id, "public");
    this.transitioned.add(id);
  }

  /**
   * @internal Apply a recorded `unpublish` event's effect: set `id` to
   * `private`. Module-private via `INTERNAL_TOKEN`.
   */
  applyUnpublish(id: SnapshotId, token: typeof INTERNAL_TOKEN): void {
    if (token !== INTERNAL_TOKEN) {
      throw new Error("VisibilityLog.applyUnpublish: internal token required");
    }
    this.states.set(id, "private");
    this.transitioned.add(id);
  }

  /**
   * @internal Apply a pre-publish **initial** state assignment: set `id` to a
   * non-public `state`. Rejects `public` (reachable only via `publish`), rejects
   * any assignment when `id` is currently `public` (leaving `public` requires
   * `unpublish`), and rejects any assignment once `id` has any prior
   * publish/unpublish transition history — even if a later `unpublish` returned
   * its current state to `private`. A transitioned snapshot may not be re-seeded
   * as a fresh pre-publish snapshot; this prevents a `local-only` post-transition
   * seed from overriding recorded transition history. Module-private via
   * `INTERNAL_TOKEN`.
   */
  applyInitial(
    id: SnapshotId,
    state: VisibilityState,
    token: typeof INTERNAL_TOKEN,
  ): void {
    if (token !== INTERNAL_TOKEN) {
      throw new Error("VisibilityLog.applyInitial: internal token required");
    }
    if (state === "public") {
      throw new Error(
        "VisibilityLog: cannot set public directly; use publish() to append a publish op-log event",
      );
    }
    if (this.transitioned.has(id)) {
      throw new Error(
        "VisibilityLog: cannot apply initial state after transition history; use publish()/unpublish() to transition",
      );
    }
    if (this.states.get(id) === "public") {
      throw new Error(
        "VisibilityLog: cannot leave public via setVisibility; use unpublish() to append an unpublish op-log event",
      );
    }
    this.states.set(id, state);
  }
}

/**
 * Replay publish/unpublish events into a fresh `VisibilityLog`, optionally
 * restoring durable non-public **initial** visibility states first.
 *
 * Pre-publish states such as `embargoed`/`local-only` are not op-log events, so
 * a pure op-log replay would lose them and default every snapshot to
 * `DEFAULT_VISIBILITY` (`private`). To preserve these durable initial states
 * across a restart, callers pass the stored non-public initial states via
 * `initialStates`; they are applied through the same internal initial setter
 * (`applyInitial`) as `setVisibility`, so the mutation invariant is preserved:
 * a `public` initial seed is rejected, and only `publish`/`unpublish` op-log
 * events may reach or leave `public`.
 *
 * Initial seeds are applied BEFORE replaying publish/unpublish events in
 * append order, so a recorded `publish` for a seed-`embargoed` snapshot still
 * flips it to `public`, and a recorded `unpublish` still re-privatizes it. A
 * `local-only` seed with no later `publish` stays `local-only` (and a later
 * `publish` attempt on it would still be rejected at `publish()` time, not
 * during replay). Once a snapshot has any replayed publish/unpublish event, it
 * is marked as transitioned, so a subsequent `setVisibility` (initial seed) for
 * it is rejected — a post-transition initial seed cannot override recorded
 * transition history.
 *
 * @param log The op-log whose `publish`/`unpublish` events are replayed.
 * @param initialStates Optional durable non-public initial states, as an
 *   iterable of `[SnapshotId, VisibilityState]` pairs or a `Map`. A `public`
 *   entry is rejected (it must come from a recorded `publish` event).
 */
export function replayVisibilityLog(
  log: OpLog,
  initialStates?:
    | Iterable<[SnapshotId, VisibilityState]>
    | Map<SnapshotId, VisibilityState>,
): VisibilityLog {
  const vis = new VisibilityLog();
  if (initialStates !== undefined) {
    const entries: Iterable<[SnapshotId, VisibilityState]> =
      initialStates instanceof Map ? initialStates : initialStates;
    for (const [id, state] of entries) {
      vis.applyInitial(id, state, INTERNAL_TOKEN);
    }
  }
  for (const event of log.list()) {
    if (event.kind === "publish") {
      vis.applyPublish(event.snapshotId, INTERNAL_TOKEN);
    } else if (event.kind === "unpublish") {
      vis.applyUnpublish(event.snapshotId, INTERNAL_TOKEN);
    }
  }
  return vis;
}

/**
 * Publish a snapshot: transition its visibility to `public` and append a
 * `publish` op-log event. The source state must be one of `PUBLISHABLE_STATES`
 * (`private` or `embargoed`); publishing an already-public or `local-only`
 * snapshot is rejected (no-op publish is an error, not a silent success).
 *
 * Returns the new visibility (`public`) and updates `vis` accordingly. No time
 * side channel: this is the only way an `embargoed` snapshot becomes public.
 * The op-log event is appended BEFORE the visibility mutation so a throw from
 * `publishTarget` leaves both the log and the map unchanged.
 */
export function publish(
  log: OpLog,
  vis: VisibilityLog,
  snapshotId: SnapshotId,
  timestamp: number = Date.now(),
): VisibilityState {
  const to = publishTarget(vis.get(snapshotId));
  appendPublish(log, { snapshotId }, timestamp);
  vis.applyPublish(snapshotId, INTERNAL_TOKEN);
  return to;
}

/**
 * Unpublish a snapshot: re-privatize a public snapshot to `private` for future
 * readers, appending a NEW `unpublish` op-log event (plan §2 decision 7). The
 * op-log stays append-only; already-exported content cannot be recalled.
 *
 * Only `public` snapshots can be unpublished. Returns the new visibility
 * (`private`). The op-log event is appended BEFORE the visibility mutation.
 */
export function unpublish(
  log: OpLog,
  vis: VisibilityLog,
  snapshotId: SnapshotId,
  timestamp: number = Date.now(),
): VisibilityState {
  const from = vis.get(snapshotId);
  const to = unpublishTarget(from);
  appendUnpublish(log, { snapshotId }, timestamp);
  vis.applyUnpublish(snapshotId, INTERNAL_TOKEN);
  return to;
}

/**
 * Explicitly set a snapshot's visibility to a **non-public initial** state
 * (e.g. to `embargoed` or `local-only`) without a publish transition. This is
 * how an owner marks content as embargoed or local-only before any publish. It
 * does not append an op-log event (it is a pre-publish state assignment); the
 * subsequent `publish` is what records the transition.
 *
 * Rejects `public` (reachable only via `publish()`), rejects any assignment
 * once the snapshot is `public` (leaving `public` requires `unpublish()`), and
 * rejects any assignment once the snapshot has any prior publish/unpublish
 * transition history — even if a later `unpublish` returned its current state to
 * `private`. Initial visibility is a pre-publish concept only; a transitioned
 * snapshot cannot be re-seeded, so the op-log mutation invariant cannot be
 * bypassed through this setter and a `local-only` post-transition seed cannot
 * override recorded transition history.
 */
export function setVisibility(
  vis: VisibilityLog,
  snapshotId: SnapshotId,
  state: VisibilityState,
): void {
  vis.applyInitial(snapshotId, state, INTERNAL_TOKEN);
}
