// gtw public entrypoint. C0 bootstrap exposed only the version constant.
// C1 adds the core object model exports (content-addressed blobs, the
// ContentObject storage envelope, the signed ACL metadata graph, and the
// minimal SnapshotEnvelope storage contract). Later chunks add store, vfs,
// snapshot, policy, and CLI commands.

export const version = "0.0.0" as const;

export * from "./core/ids.ts";
export * from "./core/object.ts";
export * from "./core/acl.ts";
export * from "./core/snapshot-contract.ts";
export * from "./core/secret-blob.ts";
export * from "./store/store.ts";
export * from "./store/memory-store.ts";
export * from "./store/fs-store.ts";
export * from "./vfs/vfs.ts";
export * from "./vfs/ops.ts";
export * from "./vfs/materialize.ts";
export * from "./crypto/keys.ts";
export * from "./crypto/secret.ts";
export * from "./crypto/policy.ts";

export * from "./snapshot/snapshot.ts";
export * from "./snapshot/bookmark.ts";
export * from "./snapshot/oplog.ts";
export * from "./workspace/working-copy.ts";

// C6: per-file / per-snapshot visibility states, authorization, publish/
// unpublish transitions, private manifest, and public export bundle.
// C6 visibility: explicit named exports instead of a star export, to avoid an
// ambiguous root `Denied` (crypto `./crypto/secret.ts` already exports `Denied`).
// The policy denial class is re-exported under the unique name `VisibilityDenied`.
export {
  type VisibilityState,
  VISIBILITY_STATES,
  type ActorRole,
  type VisibilityOperation,
  type MatrixDecision,
  Denied as VisibilityDenied,
  matrixDecision,
  resolveRole,
  PUBLISHABLE_STATES,
  publishTarget,
  unpublishTarget,
} from "./policy/visibility.ts";
export * from "./policy/authorization.ts";
export * from "./policy/transitions.ts";
export * from "./policy/private-manifest.ts";
export * from "./export/public-manifest.ts";
// C7: independent workspaces with conflict-as-data.
export * from "./workspace/workspace.ts";
export * from "./workspace/conflict.ts";
