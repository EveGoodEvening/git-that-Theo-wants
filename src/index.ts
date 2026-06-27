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
export * from "./vfs/vfs.ts";
export * from "./vfs/ops.ts";
export * from "./crypto/keys.ts";
export * from "./crypto/secret.ts";
export * from "./crypto/policy.ts";

export * from "./snapshot/snapshot.ts";
export * from "./snapshot/bookmark.ts";
export * from "./snapshot/oplog.ts";
export * from "./workspace/working-copy.ts";

// C7: independent workspaces with conflict-as-data.
export * from "./workspace/workspace.ts";
export * from "./workspace/conflict.ts";