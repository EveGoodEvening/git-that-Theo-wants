// C4 unit tests: bookmarks/tags are named SnapshotId pointers and every move
// is recorded in the append-only op-log.

import { describe, expect, it } from "bun:test";
import type { SnapshotId } from "../../src/core/ids.ts";
import { asSnapshotId } from "../../src/core/ids.ts";
import { BookmarkExists, BookmarkNotFound, Bookmarks } from "../../src/snapshot/bookmark.ts";
import { OpLog } from "../../src/snapshot/oplog.ts";

const SNAP_A = asSnapshotId("a".repeat(64));
const SNAP_B = asSnapshotId("b".repeat(64));
const SNAP_C = asSnapshotId("c".repeat(64));

function attemptFrozenMutation(mutator: () => void): void {
  try {
    mutator();
  } catch (e) {
    expect(e).toBeInstanceOf(TypeError);
  }
}

describe("C4 bookmarks and tags", () => {
  it("records bookmark creation and moves as op-log events", () => {
    const log = new OpLog();
    const pointers = new Bookmarks(log);

    const created = pointers.createBookmark("main", SNAP_A);
    expect(pointers.getBookmark("main")).toBe(SNAP_A);
    expect(created.kind).toBe("bookmark-move");
    expect(created.seq).toBe(1);
    expect(created.name).toBe("main");
    expect(created.from).toBeNull();
    expect(created.to).toBe(SNAP_A);

    const moved = pointers.moveBookmark("main", SNAP_B);
    expect(pointers.getBookmark("main")).toBe(SNAP_B);
    expect(moved.kind).toBe("bookmark-move");
    expect(moved.seq).toBe(2);
    expect(moved.from).toBe(SNAP_A);
    expect(moved.to).toBe(SNAP_B);

    const events = log.list();
    expect(events.length).toBe(2);
    events.pop();
    expect(log.length).toBe(2);
    expect(log.at(created.seq)).toEqual(created);
    expect(log.at(moved.seq)).toEqual(moved);
  });

  it("records tag creation and moves as op-log events", () => {
    const log = new OpLog();
    const pointers = new Bookmarks(log);

    const created = pointers.createTag("v1", SNAP_A);
    const moved = pointers.moveTag("v1", SNAP_C);

    expect(pointers.listTags()).toEqual(["v1"]);
    expect(pointers.getTag("v1")).toBe(SNAP_C);
    expect(created.kind).toBe("tag-move");
    expect(created.from).toBeNull();
    expect(created.to).toBe(SNAP_A);
    expect(moved.kind).toBe("tag-move");
    expect(moved.from).toBe(SNAP_A);
    expect(moved.to).toBe(SNAP_C);
    expect(log.list().map((event) => event.kind)).toEqual(["tag-move", "tag-move"]);
  });

  it("rejects duplicate creations and missing moves with typed errors", () => {
    const log = new OpLog();
    const pointers = new Bookmarks(log);
    pointers.createBookmark("main", SNAP_A);
    pointers.createTag("v1", SNAP_A);

    expect(() => pointers.createBookmark("main", SNAP_B)).toThrow(BookmarkExists);
    expect(() => pointers.createTag("v1", SNAP_B)).toThrow(BookmarkExists);
    expect(() => pointers.getBookmark("missing")).toThrow(BookmarkNotFound);
    expect(() => pointers.getTag("missing")).toThrow(BookmarkNotFound);
    expect(() => pointers.moveBookmark("missing", SNAP_B)).toThrow(BookmarkNotFound);
    expect(() => pointers.moveTag("missing", SNAP_B)).toThrow(BookmarkNotFound);
    expect(log.length).toBe(2);
  });

  it("prevents append/list/at event objects from mutating log history", () => {
    const log = new OpLog();
    const appended = log.append("snapshot-create", 123, {
      snapshotId: SNAP_A,
      parentId: null,
    });

    attemptFrozenMutation(() => {
      (appended as { snapshotId: SnapshotId }).snapshotId = SNAP_B;
    });
    expect(Object.isFrozen(appended)).toBe(true);
    const afterAppendMutation = log.at(appended.seq)!;
    expect((afterAppendMutation as { snapshotId: SnapshotId }).snapshotId).toBe(SNAP_A);
    const listed = log.list()[0]!;
    attemptFrozenMutation(() => {
      (listed as { snapshotId: SnapshotId }).snapshotId = SNAP_C;
    });
    expect(Object.isFrozen(listed)).toBe(true);
    const afterListMutation = log.at(appended.seq)!;
    expect((afterListMutation as { snapshotId: SnapshotId }).snapshotId).toBe(SNAP_A);
    const fetched = log.at(appended.seq)!;
    attemptFrozenMutation(() => {
      (fetched as { timestamp: number }).timestamp = 999;
    });
    expect(Object.isFrozen(fetched)).toBe(true);
    const afterAtMutation = log.at(appended.seq)!;
    expect((afterAtMutation as { timestamp: number }).timestamp).toBe(123);
  });
});
