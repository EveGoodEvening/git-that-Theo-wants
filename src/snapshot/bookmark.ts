// C4 bookmarks and tags: named pointers to `SnapshotId`s.
//
// A bookmark (JJ-style) or tag is a named reference to a `SnapshotId`. Moving a
// bookmark/tag does **not** silently rewrite the pointer; instead the move is
// recorded as a new op-log event (see `oplog.ts`). The bookmark/tag set itself
// is a mutable `Map` of name → `SnapshotId`, but every mutation appends an
// op-log event so the history of moves is recoverable and auditable.
//
// Bookmarks and tags share the same mechanism in this prototype; the only
// distinction is intent (bookmarks are movable pointers like jj bookmarks;
// tags are labels). Both are named pointers whose moves are op-log-recorded.

import type { SnapshotId } from "../core/ids.ts";
import {
  type OpLog,
  type PointerMoveEvent,
  appendBookmarkMove,
  appendTagMove,
} from "./oplog.ts";

/**
 * Typed error raised when a bookmark/tag lookup misses (no pointer with the
 * given name). Returned instead of `undefined` so callers cannot silently treat
 * a missing pointer as present-but-empty.
 */
export class BookmarkNotFound extends Error {
  readonly name_: string;
  readonly kind: "bookmark" | "tag";

  constructor(
    kind: BookmarkNotFound["kind"],
    name: string,
    message?: string,
  ) {
    super(message ?? `BookmarkNotFound (${kind}): ${name}`);
    this.name = "BookmarkNotFound";
    this.kind = kind;
    this.name_ = name;
  }
}

/**
 * Typed error raised when creating a bookmark/tag that already exists. Use
 * `moveBookmark`/`moveTag` to update an existing pointer (which records an
 * op-log event).
 */
export class BookmarkExists extends Error {
  readonly name_: string;
  readonly kind: "bookmark" | "tag";

  constructor(
    kind: BookmarkExists["kind"],
    name: string,
    message?: string,
  ) {
    super(message ?? `BookmarkExists (${kind}): ${name}`);
    this.name = "BookmarkExists";
    this.kind = kind;
    this.name_ = name;
  }
}

/**
 * A collection of named pointers (bookmarks and tags) with op-log-recorded
 * moves. The pointer maps are mutable, but every mutation appends an op-log
 * event so the move history is recoverable.
 */
export class Bookmarks {
  private readonly bookmarks = new Map<string, SnapshotId>();
  private readonly tags = new Map<string, SnapshotId>();
  private readonly log: OpLog;

  constructor(log: OpLog) {
    this.log = log;
  }

  /** List all bookmark names in insertion order. */
  listBookmarks(): string[] {
    return Array.from(this.bookmarks.keys());
  }

  /** List all tag names in insertion order. */
  listTags(): string[] {
    return Array.from(this.tags.keys());
  }

  /** Get the `SnapshotId` a bookmark points at, or throw `BookmarkNotFound`. */
  getBookmark(name: string): SnapshotId {
    const id = this.bookmarks.get(name);
    if (id === undefined) {
      throw new BookmarkNotFound("bookmark", name);
    }
    return id;
  }

  /** Get the `SnapshotId` a tag points at, or throw `BookmarkNotFound`. */
  getTag(name: string): SnapshotId {
    const id = this.tags.get(name);
    if (id === undefined) {
      throw new BookmarkNotFound("tag", name);
    }
    return id;
  }

  /** True iff a bookmark with `name` exists. */
  hasBookmark(name: string): boolean {
    return this.bookmarks.has(name);
  }

  /** True iff a tag with `name` exists. */
  hasTag(name: string): boolean {
    return this.tags.has(name);
  }

  /**
   * Create a new bookmark pointing at `target`. Throws `BookmarkExists` if the
   * name is already in use; use `moveBookmark` to update an existing bookmark.
   * Records an op-log event.
   */
  createBookmark(name: string, target: SnapshotId): PointerMoveEvent {
    if (this.bookmarks.has(name)) {
      throw new BookmarkExists("bookmark", name);
    }
    this.bookmarks.set(name, target);
    return appendBookmarkMove(this.log, {
      name,
      from: null,
      to: target,
    });
  }

  /**
   * Create a new tag pointing at `target`. Throws `BookmarkExists` if the name
   * is already in use; use `moveTag` to update an existing tag. Records an
   * op-log event.
   */
  createTag(name: string, target: SnapshotId): PointerMoveEvent {
    if (this.tags.has(name)) {
      throw new BookmarkExists("tag", name);
    }
    this.tags.set(name, target);
    return appendTagMove(this.log, {
      name,
      from: null,
      to: target,
    });
  }

  /**
   * Move an existing bookmark to a new `target`, appending an op-log event
   * rather than silently rewriting. Throws `BookmarkNotFound` if the bookmark
   * does not exist. Returns the recorded op-log event.
   */
  moveBookmark(name: string, target: SnapshotId): PointerMoveEvent {
    const from = this.bookmarks.get(name);
    if (from === undefined) {
      throw new BookmarkNotFound("bookmark", name);
    }
    this.bookmarks.set(name, target);
    return appendBookmarkMove(this.log, { name, from, to: target });
  }

  /**
   * Move an existing tag to a new `target`, appending an op-log event rather
   * than silently rewriting. Throws `BookmarkNotFound` if the tag does not
   * exist. Returns the recorded op-log event.
   */
  moveTag(name: string, target: SnapshotId): PointerMoveEvent {
    const from = this.tags.get(name);
    if (from === undefined) {
      throw new BookmarkNotFound("tag", name);
    }
    this.tags.set(name, target);
    return appendTagMove(this.log, { name, from, to: target });
  }
}
