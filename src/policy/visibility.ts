// C6 visibility states and the deterministic state-operation matrix.
//
// Per plan §2 (C6 checklist), visibility is a first-class attribute at both the
// file level and the snapshot/ref level. There are exactly four states, and the
// operation matrix is **deterministic** — there is no time-based behavior. In
// particular `embargoed` does NOT auto-release after a clock advance; it
// requires an explicit `publish` transition (plan §2 decision: "Delayed public
// release is modeled as a disclosure policy with an explicit `publish`
// transition, not a time-based side channel").
//
// The matrix is encoded as pure functions of (state, operation, actor-role) so
// it is trivially testable and free of side channels. An "actor role" is one of:
//   - `owner`:  the authorized local actor who created/owns the content.
//   - `peer`:   a second in-process actor (a different local key) representing
//               the "other peer" from the plan's in-process public-peer demo.
//
// `local-only` is the strictest state: owner-local reads only; publish and
// export are rejected outright (the content never leaves the owner's process).

import type { ActorId } from "../core/ids.ts";

/**
 * The four visibility states (file and snapshot/ref level).
 *
 * - `public`:     readable by other peer + present in export.
 * - `private`:    authorized owner reads; other peer `Denied`; omitted from
 *                 export; `publish` -> `public`.
 * - `embargoed`:  owner reads; other peer `Denied`; omitted from export;
 *                 `publish` -> `public` (explicit only, NO time-based
 *                 auto-release).
 * - `local-only`: owner-local reads; other peer `Denied`; omitted from export;
 *                 `publish`/`export` rejected.
 */
export type VisibilityState = "public" | "private" | "embargoed" | "local-only";

/**
 * The set of visibility states, in canonical order. Used for deterministic
 * enumeration in tests and for canonical serialization.
 */
export const VISIBILITY_STATES: readonly VisibilityState[] = [
  "public",
  "private",
  "embargoed",
  "local-only",
] as const;

/**
 * An actor's role with respect to a piece of content. The role is derived from
 * the ACL graph (C1/C5) by the caller; this module only consumes the resolved
 * role, keeping the matrix a pure function of (state, op, role).
 */
export type ActorRole = "owner" | "peer";

/**
 * The operations the state-operation matrix governs.
 *
 * - `read`:     read a file's content / a snapshot's tree.
 * - `checkout`: check out a snapshot/ref into a working copy.
 * - `publish`:  transition a snapshot's visibility to `public`.
 * - `export`:   include content in a public export bundle.
 */
export type VisibilityOperation = "read" | "checkout" | "publish" | "export";

/**
 * The decision returned by the state-operation matrix.
 *
 * - `allow`: the operation is permitted.
 * - `deny`:  the operation is denied (returns `Denied` at the API boundary).
 * - `omit`:  the content is omitted from the operation's result set (used for
 *            `export`/`read` of non-public content by a peer: the content is
 *            simply not present, rather than raising an error).
 */
export type MatrixDecision = "allow" | "deny" | "omit";

/**
 * Typed authorization denial. Carries the (state, operation, role) triple that
 * produced it so callers can surface a deterministic reason without leaking
 * private metadata. The error never carries secret material or private paths.
 */
export class Denied extends Error {
  readonly state: VisibilityState;
  readonly op: VisibilityOperation;
  readonly role: ActorRole;

  constructor(
    state: VisibilityState,
    op: VisibilityOperation,
    role: ActorRole,
    message?: string,
  ) {
    super(message ?? `Denied: ${op} in state ${state} for ${role}`);
    this.name = "Denied";
    this.state = state;
    this.op = op;
    this.role = role;
  }
}

/**
 * The deterministic state-operation matrix.
 *
 * Pure function of (state, operation, role) — no time, no I/O, no side channels.
 *
 * Rules (plan C6 checklist):
 *   public     + read     + owner -> allow
 *   public     + read     + peer  -> allow
 *   public     + checkout + owner -> allow
 *   public     + checkout + peer  -> allow
 *   public     + publish  + *     -> deny   (already public; no transition)
 *   public     + export   + *     -> allow
 *   private    + read     + owner -> allow
 *   private    + read     + peer  -> deny
 *   private    + checkout + owner -> allow
 *   private    + checkout + peer  -> deny
 *   private    + publish  + owner -> allow  (private -> public)
 *   private    + publish  + peer  -> deny
 *   private    + export   + *     -> omit   (omitted from export)
 *   embargoed  + read     + owner -> allow
 *   embargoed  + read     + peer  -> deny
 *   embargoed  + checkout + owner -> allow
 *   embargoed  + checkout + peer  -> deny
 *   embargoed  + publish  + owner -> allow  (embargoed -> public, explicit)
 *   embargoed  + publish  + peer  -> deny
 *   embargoed  + export   + *     -> omit
 *   local-only + read     + owner -> allow
 *   local-only + read     + peer  -> deny
 *   local-only + checkout + owner -> allow
 *   local-only + checkout + peer  -> deny
 *   local-only + publish  + *     -> deny   (never publishable)
 *   local-only + export   + *     -> deny   (never exported; not omit, an
 *                                            explicit rejection so a caller
 *                                            cannot silently strip local-only
 *                                            content into a bundle)
 */
export function matrixDecision(
  state: VisibilityState,
  op: VisibilityOperation,
  role: ActorRole,
): MatrixDecision {
  switch (state) {
    case "public":
      switch (op) {
        case "read":
        case "checkout":
        case "export":
          return "allow";
        case "publish":
          return "deny";
      }
      // exhaustiveness
      return "deny";
    case "private":
      switch (op) {
        case "read":
        case "checkout":
          return role === "owner" ? "allow" : "deny";
        case "publish":
          return role === "owner" ? "allow" : "deny";
        case "export":
          return "omit";
      }
      return "deny";
    case "embargoed":
      switch (op) {
        case "read":
        case "checkout":
          return role === "owner" ? "allow" : "deny";
        case "publish":
          return role === "owner" ? "allow" : "deny";
        case "export":
          return "omit";
      }
      return "deny";
    case "local-only":
      switch (op) {
        case "read":
        case "checkout":
          return role === "owner" ? "allow" : "deny";
        case "publish":
        case "export":
          return "deny";
      }
      return "deny";
  }
}

/**
 * Resolve an actor's role for a piece of content owned by `ownerId`. The role is
 * `owner` iff `actor === ownerId`, else `peer`. This is the deterministic
 * in-process role resolution used by the authorization checks; real
 * authn/authz is deferred (plan §2, §5).
 */
export function resolveRole(actor: ActorId, ownerId: ActorId): ActorRole {
  return actor === ownerId ? "owner" : "peer";
}

/**
 * The set of states from which a `publish` transition is allowed (for the
 * owner). `public` is excluded (no transition needed); `local-only` is excluded
 * (never publishable). This is the deterministic transition precondition,
 * independent of time.
 */
export const PUBLISHABLE_STATES: readonly VisibilityState[] = [
  "private",
  "embargoed",
] as const;

/**
 * The result state of a `publish` transition. Always `public` for the allowed
 * source states. Throws for non-publishable states.
 */
export function publishTarget(state: VisibilityState): VisibilityState {
  if (PUBLISHABLE_STATES.includes(state)) return "public";
  throw new Denied(state, "publish", "owner", `publish not allowed from ${state}`);
}

/**
 * The result state of an `unpublish` transition (plan §2 decision 7): a public
 * snapshot is re-privatized to `private` for *future* readers. The op-log stays
 * append-only; already-exported content cannot be recalled.
 */
export function unpublishTarget(state: VisibilityState): VisibilityState {
  if (state !== "public") {
    throw new Denied(state, "publish", "owner", `unpublish only allowed from public`);
  }
  return "private";
}

