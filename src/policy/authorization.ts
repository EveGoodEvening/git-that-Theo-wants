// C6 deterministic authorization checks: read / checkout / publish / export.
//
// These checks are thin, deterministic wrappers over the state-operation matrix
// in `visibility.ts`. They resolve the actor's role (owner vs peer) from the
// ACL/owner binding and translate the matrix decision into either a returned
// value (allow/omit) or a typed `Denied` error. There is no time-based behavior
// and no I/O beyond the caller-supplied role resolution — keeping authorization
// a pure function of (state, op, actor, owner).
//
// Per plan §2 decision 4, access policy is bound to signed/authenticated graph
// state, not user-editable config. Role resolution here is the deterministic
// in-process stub (actor === owner -> owner, else peer); real authn/authz is
// deferred (plan §2, §5). The checks never leak private metadata in their
// error messages.

import type { ActorId } from "../core/ids.ts";
import {
  type ActorRole,
  type VisibilityOperation,
  type VisibilityState,
  Denied,
  matrixDecision,
  resolveRole,
} from "./visibility.ts";

/**
 * Options carried by every authorization check. The `ownerId` is the actor that
 * owns the content; `actor` is the actor attempting the operation. The role is
 * derived deterministically from these two.
 */
export interface AuthContext {
  readonly actor: ActorId;
  readonly ownerId: ActorId;
}

/**
 * Resolve the role for `ctx`. Exposed so callers/tests can inspect the resolved
 * role without re-deriving it.
 */
export function roleFor(ctx: AuthContext): ActorRole {
  return resolveRole(ctx.actor, ctx.ownerId);
}

/**
 * Assert that `op` is allowed on content in `state` for `ctx`. Throws `Denied`
 * on a `deny` decision. Returns `"omit"` unchanged so export filters can elide
 * non-public content without raising.
 */
export function authorize(
  state: VisibilityState,
  op: VisibilityOperation,
  ctx: AuthContext,
): "allow" | "omit" {
  const role = roleFor(ctx);
  const decision = matrixDecision(state, op, role);
  if (decision === "deny") {
    throw new Denied(state, op, role);
  }
  return decision;
}

/**
 * Authorization check for reading a file / snapshot tree. Returns `true` if the
 * read is allowed, `false` if denied (peer reading non-public content). Never
 * throws for a plain denial — callers use the boolean to decide whether to
 * surface content. A `local-only` peer read returns `false`.
 */
export function canRead(state: VisibilityState, ctx: AuthContext): boolean {
  const role = roleFor(ctx);
  return matrixDecision(state, "read", role) === "allow";
}

/**
 * Authorization check for checking out a snapshot/ref into a working copy.
 * Returns `true` if allowed. A peer checking out non-public content is denied.
 */
export function canCheckout(state: VisibilityState, ctx: AuthContext): boolean {
  const role = roleFor(ctx);
  return matrixDecision(state, "checkout", role) === "allow";
}

/**
 * Authorization check for publishing a snapshot (private/embargoed -> public).
 * Returns `true` if the owner is allowed to publish from `state`. `public` and
 * `local-only` are not publishable; a peer is never allowed to publish.
 */
export function canPublish(state: VisibilityState, ctx: AuthContext): boolean {
  const role = roleFor(ctx);
  return matrixDecision(state, "publish", role) === "allow";
}

/**
 * Authorization check for exporting content. Returns `"include"` for public
 * content (included in the export bundle), `"omit"` for private/embargoed
 * content (elided from the bundle), and throws `Denied` for `local-only`
 * content (an explicit rejection so a caller cannot silently strip local-only
 * content into a bundle).
 */
export function exportDecision(
  state: VisibilityState,
  ctx: AuthContext,
): "include" | "omit" {
  const role = roleFor(ctx);
  const decision = matrixDecision(state, "export", role);
  if (decision === "deny") {
    throw new Denied(state, "export", role);
  }
  return decision === "allow" ? "include" : "omit";
}
