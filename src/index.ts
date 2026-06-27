// gtw public entrypoint. C0 bootstrap: exposes the version constant only.
// Core object model, store, vfs, snapshot, policy, and CLI commands land in
// later chunks (C1+). Keep this file minimal and dependency-free.

export const version = "0.0.0" as const;
