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
export * from "./store/store.ts";
export * from "./store/memory-store.ts";
export * from "./vfs/vfs.ts";
export * from "./vfs/ops.ts";
