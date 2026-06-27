// C6 publish/unpublish transition tests: op-log events, append-only, no time
// side channel, publish-without-transition rejected.

import { describe, expect, it } from "bun:test";
import { OpLog, type VisibilityEvent } from "../../src/snapshot/oplog.ts";
import {
  DEFAULT_VISIBILITY,
  VisibilityLog,
  publish,
  replayVisibilityLog,
  setVisibility,
  unpublish,
} from "../../src/policy/transitions.ts";
import type { VisibilityState } from "../../src/policy/visibility.ts";
import { asSnapshotId, type SnapshotId } from "../../src/core/ids.ts";

const SNAP_A = asSnapshotId(
  "a".repeat(64),
);
const SNAP_B = asSnapshotId(
  "b".repeat(64),
);

function visEvents(log: OpLog): VisibilityEvent[] {
  return log.list().filter(
    (e): e is VisibilityEvent => e.kind === "publish" || e.kind === "unpublish",
  );
}

describe("C6 VisibilityLog", () => {
  it("default visibility is private", () => {
    const vis = new VisibilityLog();
    expect(vis.get(SNAP_A)).toBe(DEFAULT_VISIBILITY);
    expect(DEFAULT_VISIBILITY).toBe("private");
    expect(vis.has(SNAP_A)).toBe(false);
  });

  it("setVisibility records state without an op-log event", () => {
    const vis = new VisibilityLog();
    setVisibility(vis, SNAP_A, "embargoed");
    expect(vis.get(SNAP_A)).toBe("embargoed");
    expect(vis.has(SNAP_A)).toBe(true);
  });
});

describe("C6 publish transition", () => {
  it("private -> public appends a publish event and flips visibility", () => {
    const log = new OpLog();
    const vis = new VisibilityLog();
    const to = publish(log, vis, SNAP_A, 1000);
    expect(to).toBe("public");
    expect(vis.get(SNAP_A)).toBe("public");
    const evs = visEvents(log);
    expect(evs).toHaveLength(1);
    expect(evs[0].kind).toBe("publish");
    expect(evs[0].snapshotId).toBe(SNAP_A);
    expect(evs[0].timestamp).toBe(1000);
  });

  it("embargoed -> public appends a publish event", () => {
    const log = new OpLog();
    const vis = new VisibilityLog();
    setVisibility(vis, SNAP_A, "embargoed");
    const to = publish(log, vis, SNAP_A, 2000);
    expect(to).toBe("public");
    expect(vis.get(SNAP_A)).toBe("public");
    expect(visEvents(log)[0].kind).toBe("publish");
  });

  it("publish-without-transition rejected: already-public is an error", () => {
    const log = new OpLog();
    const vis = new VisibilityLog();
    publish(log, vis, SNAP_A, 1000);
    expect(() => publish(log, vis, SNAP_A, 2000)).toThrow();
    // Op-log unchanged: still one event.
    expect(visEvents(log)).toHaveLength(1);
  });

  it("local-only cannot be published", () => {
    const log = new OpLog();
    const vis = new VisibilityLog();
    setVisibility(vis, SNAP_A, "local-only");
    expect(() => publish(log, vis, SNAP_A, 1000)).toThrow();
    expect(visEvents(log)).toHaveLength(0);
    expect(vis.get(SNAP_A)).toBe("local-only");
  });

  it("peer cannot publish (role enforced by caller via owner-only API)", () => {
    // The transitions module is the owner-only API; a peer call would be
    // rejected at the authorization layer (see authorization.test.ts). Here we
    // assert the transition precondition is independent of time.
    const log = new OpLog();
    const vis = new VisibilityLog();
    setVisibility(vis, SNAP_A, "embargoed");
    // No clock advance changes embargoed visibility — only explicit publish.
    expect(vis.get(SNAP_A)).toBe("embargoed");
    publish(log, vis, SNAP_A, 9999);
    expect(vis.get(SNAP_A)).toBe("public");
  });
});

describe("C6 unpublish (re-privatization)", () => {
  it("public -> private appends a NEW unpublish event; op-log append-only", () => {
    const log = new OpLog();
    const vis = new VisibilityLog();
    publish(log, vis, SNAP_A, 1000);
    unpublish(log, vis, SNAP_A, 2000);
    expect(vis.get(SNAP_A)).toBe("private");
    const evs = visEvents(log);
    expect(evs).toHaveLength(2);
    expect(evs[0].kind).toBe("publish");
    expect(evs[1].kind).toBe("unpublish");
    // Append-only: seq numbers strictly increase.
    expect(evs[1].seq).toBeGreaterThan(evs[0].seq);
  });

  it("unpublish only allowed from public", () => {
    const log = new OpLog();
    const vis = new VisibilityLog();
    expect(() => unpublish(log, vis, SNAP_A, 1000)).toThrow();
    setVisibility(vis, SNAP_A, "embargoed");
    expect(() => unpublish(log, vis, SNAP_A, 1000)).toThrow();
  });

  it("publish then unpublish then publish again: three events, append-only", () => {
    const log = new OpLog();
    const vis = new VisibilityLog();
    publish(log, vis, SNAP_A, 1000);
    unpublish(log, vis, SNAP_A, 2000);
    publish(log, vis, SNAP_A, 3000);
    const evs = visEvents(log);
    expect(evs.map((e) => e.kind)).toEqual([
      "publish",
      "unpublish",
      "publish",
    ]);
    expect(vis.get(SNAP_A)).toBe("public");
  });

  it("unpublish cannot recall already-exported content (best-effort)", () => {
    // The op-log records the unpublish for future readers, but a peer that
    // already fetched the public bundle retains it. This test asserts the
    // op-log records the event; the export-bundle recall limit is exercised in
    // the export tests.
    const log = new OpLog();
    const vis = new VisibilityLog();
    publish(log, vis, SNAP_A, 1000);
    unpublish(log, vis, SNAP_A, 2000);
    // A future public peer now sees private.
    expect(vis.get(SNAP_A)).toBe("private");
    // The op-log is the auditable record; it cannot be rewritten.
    expect(visEvents(log)).toHaveLength(2);
  });

  it("replays publish/unpublish events into the current visibility", () => {
    const log = new OpLog();
    const vis = new VisibilityLog();
    publish(log, vis, SNAP_A, 1000);
    unpublish(log, vis, SNAP_A, 2000);
    const replayed = replayVisibilityLog(log);
    expect(replayed.get(SNAP_A)).toBe("private");
    expect(visEvents(log)).toHaveLength(2);
  });
});

describe("C6 no time side channel in transitions", () => {
  it("embargoed visibility is unchanged by arbitrary clock values", () => {
    const vis = new VisibilityLog();
    setVisibility(vis, SNAP_A, "embargoed");
    // "Advance the clock" — visibility is not a function of time.
    [0, 1000, 999999, Number.MAX_SAFE_INTEGER].forEach(() => {
      expect(vis.get(SNAP_A)).toBe("embargoed");
    });
    // Only an explicit publish flips it.
    const log = new OpLog();
    publish(log, vis, SNAP_A, 5);
    expect(vis.get(SNAP_A)).toBe("public");
  });
});

describe("C6 transition bypass prevention (review finding 1)", () => {
  it("VisibilityLog exposes no public arbitrary-state setter", () => {
    const vis = new VisibilityLog();
    // The old public `set` method is gone; only `get`/`has` and the
    // token-gated `apply*` methods remain. A direct `public` assignment is
    // not expressible from outside this module.
    expect((vis as unknown as Record<string, unknown>).set).toBeUndefined();
  });

  it("setVisibility rejects setting state to public directly", () => {
    const vis = new VisibilityLog();
    expect(() => setVisibility(vis, SNAP_A, "public")).toThrow();
    expect(vis.get(SNAP_A)).toBe("private");
    expect(vis.has(SNAP_A)).toBe(false);
  });

  it("setVisibility rejects leaving public (must use unpublish)", () => {
    const log = new OpLog();
    const vis = new VisibilityLog();
    publish(log, vis, SNAP_A, 1000);
    expect(vis.get(SNAP_A)).toBe("public");
    // Cannot re-assign a public snapshot's state via setVisibility; only
    // unpublish() (which appends an op-log event) may leave public.
    expect(() => setVisibility(vis, SNAP_A, "private")).toThrow();
    expect(() => setVisibility(vis, SNAP_A, "embargoed")).toThrow();
    expect(() => setVisibility(vis, SNAP_A, "local-only")).toThrow();
    // State unchanged: still public, no op-log event added.
    expect(vis.get(SNAP_A)).toBe("public");
    expect(visEvents(log)).toHaveLength(1);
  });

  it("setVisibility allows non-public initial states (private/embargoed/local-only)", () => {
    const vis = new VisibilityLog();
    setVisibility(vis, SNAP_A, "embargoed");
    expect(vis.get(SNAP_A)).toBe("embargoed");
    setVisibility(vis, SNAP_A, "local-only");
    expect(vis.get(SNAP_A)).toBe("local-only");
    setVisibility(vis, SNAP_A, "private");
    expect(vis.get(SNAP_A)).toBe("private");
  });

  it("publish appends a publish op-log event; direct public set is impossible", () => {
    const log = new OpLog();
    const vis = new VisibilityLog();
    const before = visEvents(log).length;
    publish(log, vis, SNAP_A, 1000);
    const evs = visEvents(log);
    expect(evs.length).toBe(before + 1);
    expect(evs[evs.length - 1].kind).toBe("publish");
    expect(evs[evs.length - 1].snapshotId).toBe(SNAP_A);
    expect(vis.get(SNAP_A)).toBe("public");
  });

  it("unpublish appends an unpublish op-log event after publish", () => {
    const log = new OpLog();
    const vis = new VisibilityLog();
    publish(log, vis, SNAP_A, 1000);
    const before = visEvents(log).length;
    unpublish(log, vis, SNAP_A, 2000);
    const evs = visEvents(log);
    expect(evs.length).toBe(before + 1);
    expect(evs[evs.length - 1].kind).toBe("unpublish");
    expect(evs[evs.length - 1].snapshotId).toBe(SNAP_A);
    expect(vis.get(SNAP_A)).toBe("private");
  });

  it("replayVisibilityLog reconstructs public only from publish events", () => {
    const log = new OpLog();
    publish(log, new VisibilityLog(), SNAP_A, 1000);
    const replayed = replayVisibilityLog(log);
    expect(replayed.get(SNAP_A)).toBe("public");
    // A replayed log has no way to reach public without a recorded publish
    // event in the op-log.
    const empty = replayVisibilityLog(new OpLog());
    expect(empty.get(SNAP_A)).toBe("private");
  });
});

describe("C6 replayVisibilityLog durable initial states", () => {
  it("local-only initial state is preserved across replay and publish still throws", () => {
    const log = new OpLog();
    const vis = new VisibilityLog();
    setVisibility(vis, SNAP_A, "local-only");
    // Persist the durable non-public initial state, then restart (replay).
    const initialStates: [SnapshotId, VisibilityState][] = [
      [SNAP_A, vis.get(SNAP_A)],
    ];
    const replayed = replayVisibilityLog(log, initialStates);
    expect(replayed.get(SNAP_A)).toBe("local-only");
    // local-only still cannot be published after replay.
    expect(() => publish(log, replayed, SNAP_A, 1000)).toThrow();
    expect(visEvents(log)).toHaveLength(0);
    expect(replayed.get(SNAP_A)).toBe("local-only");
  });

  it("embargoed initial state is preserved and can publish explicitly after replay", () => {
    const log = new OpLog();
    const vis = new VisibilityLog();
    setVisibility(vis, SNAP_A, "embargoed");
    const replayed = replayVisibilityLog(log, [[SNAP_A, "embargoed"]]);
    expect(replayed.get(SNAP_A)).toBe("embargoed");
    // An explicit publish after replay still works and appends the event.
    const to = publish(log, replayed, SNAP_A, 2000);
    expect(to).toBe("public");
    expect(replayed.get(SNAP_A)).toBe("public");
    expect(visEvents(log).map((e) => e.kind)).toEqual(["publish"]);
  });

  it("public initial seed is rejected", () => {
    const log = new OpLog();
    expect(() => replayVisibilityLog(log, [[SNAP_A, "public"]])).toThrow();
    // A Map form is also rejected.
    expect(() =>
      replayVisibilityLog(log, new Map([[SNAP_A, "public"]])),
    ).toThrow();
  });

  it("replay applies publish/unpublish after initial seeds in order", () => {
    const log = new OpLog();
    // Build an op-log: SNAP_A embargoed -> publish -> unpublish; SNAP_B
    // embargoed -> publish. Replay must apply the non-public seeds first, then
    // the recorded publish/unpublish events in append order.
    const seedVis = new VisibilityLog();
    setVisibility(seedVis, SNAP_A, "embargoed");
    setVisibility(seedVis, SNAP_B, "embargoed");
    publish(log, seedVis, SNAP_A, 1000);
    unpublish(log, seedVis, SNAP_A, 2000);
    publish(log, seedVis, SNAP_B, 3000);

    const replayed = replayVisibilityLog(log, [
      [SNAP_A, "embargoed"],
      [SNAP_B, "embargoed"],
    ]);
    // SNAP_A: embargoed seed -> publish -> unpublish => private.
    expect(replayed.get(SNAP_A)).toBe("private");
    // SNAP_B: embargoed seed -> publish => public.
    expect(replayed.get(SNAP_B)).toBe("public");
    expect(visEvents(log).map((e) => e.kind)).toEqual([
      "publish",
      "unpublish",
      "publish",
    ]);
  });

  it("replay without initialStates preserves the original behavior", () => {
    const log = new OpLog();
    publish(log, new VisibilityLog(), SNAP_A, 1000);
    const replayed = replayVisibilityLog(log);
    expect(replayed.get(SNAP_A)).toBe("public");
    // No seed => default private for unseen snapshots.
    expect(replayed.get(SNAP_B)).toBe("private");
  });

  it("replay accepts a Map of initial states", () => {
    const log = new OpLog();
    const replayed = replayVisibilityLog(
      log,
      new Map([
        [SNAP_A, "embargoed"],
        [SNAP_B, "local-only"],
      ]),
    );
    expect(replayed.get(SNAP_A)).toBe("embargoed");
    expect(replayed.get(SNAP_B)).toBe("local-only");
  });
});

describe("C6 transition-history invariant (review finding: initial-only)", () => {
  it("publish -> unpublish -> setVisibility(local-only) throws even though current state is private", () => {
    const log = new OpLog();
    const vis = new VisibilityLog();
    publish(log, vis, SNAP_A, 1000);
    unpublish(log, vis, SNAP_A, 2000);
    // Current state is private after unpublish, but the snapshot has transition
    // history. An initial seed must be rejected — local-only cannot be retro-
    // actively imposed to override the recorded publish/unpublish history.
    expect(vis.get(SNAP_A)).toBe("private");
    expect(vis.hasTransitioned(SNAP_A)).toBe(true);
    expect(() => setVisibility(vis, SNAP_A, "local-only")).toThrow();
    expect(() => setVisibility(vis, SNAP_A, "embargoed")).toThrow();
    expect(() => setVisibility(vis, SNAP_A, "private")).toThrow();
    // State unchanged: still private, no op-log event added.
    expect(vis.get(SNAP_A)).toBe("private");
    expect(visEvents(log)).toHaveLength(2);
  });

  it("publish alone marks transitioned; setVisibility rejects afterwards", () => {
    const log = new OpLog();
    const vis = new VisibilityLog();
    publish(log, vis, SNAP_A, 1000);
    expect(vis.hasTransitioned(SNAP_A)).toBe(true);
    expect(() => setVisibility(vis, SNAP_A, "embargoed")).toThrow();
    expect(() => setVisibility(vis, SNAP_A, "local-only")).toThrow();
    expect(vis.get(SNAP_A)).toBe("public");
  });

  it("plain initial local-only before any transition is still allowed", () => {
    const vis = new VisibilityLog();
    expect(vis.hasTransitioned(SNAP_A)).toBe(false);
    setVisibility(vis, SNAP_A, "local-only");
    expect(vis.get(SNAP_A)).toBe("local-only");
    expect(vis.hasTransitioned(SNAP_A)).toBe(false);
    // Re-assigning another non-public initial state before any transition is
    // still permitted (no transition history yet).
    setVisibility(vis, SNAP_A, "embargoed");
    expect(vis.get(SNAP_A)).toBe("embargoed");
  });

  it("replay with initial local-only plus old publish/unpublish events yields transition-derived state and rejects later initial seed", () => {
    const log = new OpLog();
    // Build an op-log with a publish/unpublish history for SNAP_A using a
    // single VisibilityLog so unpublish sees the public state.
    const histVis = new VisibilityLog();
    publish(log, histVis, SNAP_A, 1000);
    unpublish(log, histVis, SNAP_A, 2000);
    // A caller attempts to also pass a local-only initial seed for SNAP_A
    // alongside the transition history. The seed is applied first (no
    // transition history yet at seed time), then the recorded publish/unpublish
    // events replay and mark SNAP_A as transitioned, deriving `private`.
    const replayed = replayVisibilityLog(log, [[SNAP_A, "local-only"]]);
    expect(replayed.get(SNAP_A)).toBe("private");
    expect(replayed.hasTransitioned(SNAP_A)).toBe(true);
    // After replay, a further initial seed for the transitioned snapshot is
    // rejected — local-only cannot become a post-transition override.
    expect(() => setVisibility(replayed, SNAP_A, "local-only")).toThrow();
    expect(() => setVisibility(replayed, SNAP_A, "embargoed")).toThrow();
    expect(replayed.get(SNAP_A)).toBe("private");
  });

  it("local-only immediately before restart cannot be represented as a post-transition seed that overrides transition history", () => {
    // Scenario: a snapshot was published and unpublished (transition history),
    // then the owner tries to mark it local-only right before a restart and
    // persist that as an initial seed. The transition history must win: the
    // post-transition local-only seed is rejected at apply time after replay.
    const log = new OpLog();
    const histVis = new VisibilityLog();
    publish(log, histVis, SNAP_A, 1000);
    unpublish(log, histVis, SNAP_A, 2000);
    // Attempting to seed local-only for a snapshot that has transition history
    // in the same op-log: replay applies the seed first (allowed, no history
    // yet), then replays transitions which mark it transitioned. The final
    // state is the transition-derived `private`, not the seeded `local-only`.
    const replayed = replayVisibilityLog(log, [[SNAP_A, "local-only"]]);
    expect(replayed.get(SNAP_A)).toBe("private");
    expect(replayed.hasTransitioned(SNAP_A)).toBe(true);
    // And a fresh post-replay setVisibility(local-only) is rejected.
    expect(() => setVisibility(replayed, SNAP_A, "local-only")).toThrow();
  });

  it("replay without transition events keeps a local-only seed non-transitioned and settable", () => {
    const log = new OpLog();
    const replayed = replayVisibilityLog(log, [[SNAP_A, "local-only"]]);
    expect(replayed.get(SNAP_A)).toBe("local-only");
    expect(replayed.hasTransitioned(SNAP_A)).toBe(false);
    // No transition history, so a further initial re-seed is still allowed.
    setVisibility(replayed, SNAP_A, "embargoed");
    expect(replayed.get(SNAP_A)).toBe("embargoed");
  });

  it("hasTransitioned is false for an unseen snapshot and unaffected by get/has", () => {
    const vis = new VisibilityLog();
    expect(vis.hasTransitioned(SNAP_A)).toBe(false);
    vis.get(SNAP_A);
    vis.has(SNAP_A);
    expect(vis.hasTransitioned(SNAP_A)).toBe(false);
  });
});
