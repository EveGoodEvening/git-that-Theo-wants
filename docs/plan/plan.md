# Durable Plan — "Git that Theo wants" (gtw) first prototype

> Status: **Planning only.** No product code has been implemented. This file is the
> source of truth for resuming implementation deterministically. Update the
> companion `docs/plan/checklist.md` as chunks complete; keep this file stable
> unless scope/assumptions change.

## 0. Repository state at planning time

- Repo contains **only** `README.md` and `.git`. Confirmed via `glob` and `git log`.
- Single commit on `master`: `72c90de docs(readme): add project rationale`.
- **No existing durable plan/tracker.** No `docs/`, no source, no `package.json`,
  no CI, no tests. This is the first planning artifact.
- **No implementation started.** Every chunk below is unchecked.
- Available runtimes on the planning host: Node v24.18.0, Bun 1.3.14, Python 3.12.3,
  Rust 1.96.0, Go 1.26.4. The plan picks **TypeScript + Bun** (see §3).

## 1. Goal

Build a **new source-control prototype** (working name `gtw`) that directly
addresses the six pain points in `README.md`:

1. Secrets/`.env` committable as first-class content without leaking plaintext.
2. Fine-grained, **file-level** permissions (private files, private PR-equivalents,
   delayed public release) — not just repo-level.
3. Partial-public open source: one repo can expose a subset of code publicly.
4. JJ-style **snapshot + tag** model replacing commits + branches.
5. Workspaces that do **not** hijack/lock each other (no worktree locking).
6. Decoupling from the real OS/filesystem: operate on in-memory/virtual file trees;
   real-FS materialization is an optional adapter.

The deliverable is a **realistic first prototype that demonstrates the pain
points via local deterministic simulation**, not a production VCS and not a
server-backed control plane (see §2 privacy scope, §4 in-scope, §5 out-of-scope).

## 2. Rationale & assumptions (from delegated context)

These are recorded because **no user clarification is available**. They are
planning assumptions, not commitments; an implementer may revisit with rationale.

### Product assumptions

- Theo is **inspiration only**; he has NOT endorsed this project. Product naming
  and docs must not claim affiliation. (`README.md` already states this.)
- The product is a **prototype**, not a Git replacement for production scale.
  Correctness and demonstrating pain-point solutions beat Git-grade perf.
- Greenfield repo: no existing languages/frameworks to conform to. Technology
  choice is open and decided here in §3.
- **First prototype is local-first** (library + CLI over an in-memory core with a
  real-FS adapter). A server/control-plane is explicitly **out-of-scope** for this
  prototype (see §5) but the data model must not preclude it.
- **Privacy scope is deliberately narrowed to local deterministic simulation.**
  The delegated context contains a conflicting server-backed requirement
  (context-product-2: "permissions must be enforced by a server/control-plane
  source of truth"). This prototype does **not** satisfy that requirement and does
  **not** claim to. Acceptance criteria below verify **in-process deterministic
  policy decisions** between in-process actors (a second actor = a different local
  key), not production/server security. This is recorded as an explicit scope
  downgrade, not a silent gap: real authn/authz, key distribution, audit logs,
  network transfer, and server-side enforcement are deferred (see §5). The
  README pain-point demonstration remains credible because it shows the *data
  model* (encrypted-at-rest secrets, separate public/private manifests, visibility
  transitions, workspace independence) solving the pain points *deterministically
  in a single process* — which is the honest first step before any server chunk.
  A future server/control-plane chunk is the upgrade path, not this prototype.
- Snapshots are **content-addressed** (hash of core content + core metadata —
  parent id, **canonical tree entries (path + blob id)**, timestamp, message,
  immutable flag; manifest refs are excluded, see decision 10) for dedup and
  verifiable history, following the Git/JJ lineage. Tree identity is the
  canonical set of `(path, blobId)` pairs, so a path-only rename/move changes
  the `SnapshotId` even when every blob id is unchanged.
- Tags/bookmarks are **named pointers** to snapshots; moving a bookmark records a
  new op-log event rather than silently rewriting history.
- Workspaces are **independent**; checking out the same snapshot in multiple
  workspaces is always allowed. No ref locking.
- Secrets are **encrypted at rest** in the object store and decrypted only for
  authorized actors; plaintext never appears in public/shared snapshot content.
- Delayed public release is modeled as a **disclosure policy** with an explicit
  `publish` transition, not a time-based side channel.
- **In-memory/virtual-FS is the primary execution path**; real-filesystem
  checkout is an optional compat/export path. This directly addresses pain point
  #6 and the APFS small-file rant.
- The plan is split into **dependency-ordered, verifiable, committable chunks**
  so resume is deterministic from any completed chunk.

### Research-grounded constraints (prior art)

- **git-crypt is the anti-model.** It is a git-filter bolt-on: AES-256-CTR with a
  synthetic IV from SHA-1 HMAC, cannot revoke access or rotate keys for historical
  data, and leaks file names, commit messages, symlink targets, file lengths, and
  change timing. The prototype must treat encryption/access as a **core
  object-store capability**, not a filter. [git-crypt README: "does not support
  revoking access ... no support for rotating the key"; "does not encrypt file
  names, commit messages, symlink targets ... does not hide when a file does or
  doesn't change, the length of a file".]
- **Git tree objects cannot express file-level permissions.** Tree entries store
  only three modes (100644 normal, 100755 executable, 120000 symlink) and no ACL
  metadata beyond the executable bit. Therefore the prototype needs an
  **access-control layer in its own metadata graph**, not in tree mode bits.
- **Git partial clone / sparse-checkout ≠ access control.** They omit objects for
  bandwidth, not for secrecy; they assume the client is trusted once granted repo
  access. The plan must distinguish "object omission for bandwidth" from "access
  denial for secrecy".
- **Jujutsu (jj) is the reference for the snapshot model:** working-copy-as-a-
  commit auto-snapshotted on every command, no index/staging area, no "current
  branch" (bookmarks updated manually), conflicts recorded as first-class objects,
  descendant auto-rebase, and an operation log replacing reflog. [jj README.]
- **jj abstracts VCS algorithms from storage backends** — many possible physical
  backends. The prototype mirrors this with a pluggable `Store` interface and an
  in-memory default backend.
- **Git worktrees fail pain point #5**: a worktree checked out to a branch locks
  that branch for other worktrees and can lock out the main directory. The
  prototype makes workspaces independent of ref ownership (closer to jj's "repo is
  the source of truth, working copy is just a materialization").

### Key design decisions (resolved at planning time)

1. **ACL-overlay, not capability-addressing.** Content-addressing is preserved for
   blobs; access control lives in a **separate signed metadata graph** layered over
   content objects. This avoids breaking dedup and is the least surprising fork.
   (Research Risk-4 called this out as a foundational data-model fork; we pick the
   ACL-overlay branch and record it.) Revisit only if C6 proves it insufficient.
2. **Metadata privacy is a separate problem from ciphertext.** Public manifests and
   private manifests are separated; private object metadata (paths, sizes, change
   timing, op-log entries, manifest refs, blob/secret ids, **and full `SnapshotId`
   values**) must not leak into public exports. Public exports use
   **public-projection ids** derived only from public entries/public metadata, not
   full `SnapshotId`s (which embed timestamps, messages, private paths, and private blob ids and
   are therefore private; manifest refs are envelope attachments excluded from the
   `SnapshotId` hash — see decision 10); see C6. The public manifest/bundle has an
   **explicit schema** (see C6) listing every field it *may* contain; acceptance
   tests assert the absence of every
   private metadata class, not just bytes/path strings, and assert that identical
   public entries with different private-only history produce identical public
   manifests/bundle hashes. (Research Risk-1.)
3. **Revocation is best-effort for the prototype.** History is not re-encrypted on
   revoke; revocation prevents *future* reads by revoked actors but cannot recall
   already-fetched history. Recorded as a known limitation, not a silent gap.
   (Research Risk-2.)
4. **Access policy is bound to signed/authenticated graph state**, not to a
   user-editable config file (git-crypt's `.gitattributes` tampering failure mode).
   (Research Risk-3.)
5. **Snapshot trigger policy:** auto-snapshot on command boundary (like jj), with
   an explicit immutable-marker so auto-snapshots can be squashed without rewriting
   published history. (Research Risk-5.)
6. **TypeScript + Bun** as the runtime/test runner (see §3).
7. **Publish is irreversible; rollback is a new op-log event, not a true unpublish.**
   Once a snapshot is `publish`ed to public, the op-log records the transition.
   A later `unpublish`/re-privatization is modeled as a **new visibility-changing
   op-log event** that flips the snapshot's visibility back to `private` for
   *future* readers; it cannot recall content already fetched/exported by a public
   peer (same best-effort limit as revocation, decision 3). Acceptance: a publish
   followed by an unpublish leaves the op-log with two events and future public
   peers see the snapshot as private again, while the op-log itself remains
   append-only. This prevents ad-hoc rollback implementations. (Resolves the
   publish rollback/unpublish review finding.)
8. **Public exports use public-projection ids, not full `SnapshotId`s.** A full
   `SnapshotId` is content-addressed over the snapshot's **core state** (parent id,
   canonical tree entries (path + blob id), timestamp, message, immutable flag) and **excludes manifest refs**
   (`publicManifestRef`/`privateManifestRef` are envelope attachments, not identity
   — see decision 10), so it embeds timestamps, messages, private paths, and private blob ids and
   is therefore private. Public exports instead carry `PublicProjectionId`s —
   canonical ids derived **only** from public entries and public metadata,
   including the **nearest public-visible ancestor projection ids**. Parent
   projection ids are computed by eliding private-only and public-noop
   snapshots from the parent chain (a snapshot is *public-noop* if its public
   entries and its public-visible parents are unchanged from its predecessor);
   when a snapshot's public entries and public-visible parents are unchanged
   from its nearest public-visible ancestor, it **reuses that ancestor's
   `PublicProjectionId`** instead of minting a new one. Projection ids are
   therefore a deterministic function of public data alone. Two snapshots
   with identical public entries but different private-only history produce
   identical projection ids, identical public manifests, and identical
   bundle hashes — including the `public A -> private-only P -> public B`
   shape where B has the same public entries as A (B reuses A's
   `PublicProjectionId`, matching the no-private-history case).
9. **`SecretBlob` ciphertext is self-describing and framed.** The stored
   `ciphertext` bytes carry their own nonce/IV, algorithm, version, and GCM auth
   tag — laid out as `version(1) || algId(1) || iv(12) || ciphertext(N) || tag(16)`
   — so decryption is implementable from the stored bytes alone with no
   out-of-band IV. This makes the store round-trip complete (the bytes returned by
   `getObject` are sufficient to decrypt) and keeps key-rotation denial covered
   (a wrong key fails GCM auth-tag verification → `Denied`). (Resolves the
   AES-GCM SecretBlob-contract-incomplete adversarial finding.)
10. **`SnapshotId` excludes manifest refs to break the manifest hash cycle.** The
   `SnapshotId` is the content hash of the snapshot's **core state** only —
   `parentId`, the tree's **canonical tree entries (path + blob id)**,
   `timestamp`, `message`, and the `immutable` flag. Tree identity is the
   canonical set of `(path, blobId)` pairs (sorted by path), so a path-only
   rename/move changes the `SnapshotId` even when every blob id is unchanged.
   The `publicManifestRef` and `privateManifestRef` fields are **manifest-ref
   attachments**: C4 stores and round-trips them opaquely, but they are **not**
   inputs to the `SnapshotId` hash and are **not** embedded in immutable
   `SnapshotEnvelope.serializedBytes`. Persistence uses a separate mutable
   `ManifestRefs` attachment/index keyed by `SnapshotId`; `Store.putSnapshot`
   remains append-only/idempotent for the immutable core snapshot envelope, and
   `Store.putManifestRefs(snapshotId, refs)` is the only upsert surface for
   changing refs on an existing `SnapshotId`. This breaks what would otherwise
   be a fixed-point cycle: C6's private manifest maps `SnapshotId →
   PublicProjectionId` (so it contains `SnapshotId` values), and C6 upserts the
   private manifest's content hash into that snapshot's `privateManifestRef`;
   if `SnapshotId` hashed `privateManifestRef`, computing the manifest would
   require an id that depends on the manifest. Excluding manifest refs from the
   id makes the cycle acyclic — C6 can compute a manifest from a snapshot whose
   `SnapshotId` is already final, then attach the manifest hash without
   changing the id or replacing the immutable snapshot envelope. Acceptance:
   changing **only** `publicManifestRef`/`privateManifestRef` (including by
   upserting a new `ManifestRefs` attachment for the same `SnapshotId`) does
   **not** change the `SnapshotId`; `Snapshot.withManifestRefs` preserves the
   same `SnapshotId`; changing `parentId`, any tree entry (path or blob id),
   `timestamp`, `message`, or the `immutable` flag **does** change it (a
   path-only rename/move with unchanged blob ids counts as a tree-entry change
   and therefore changes the `SnapshotId`). The `SnapshotId` remains private
   (it embeds timestamps, messages, private paths, and private blob ids), so the no-leak rule
   in decision 2 still holds. (Resolves the SnapshotId/private-manifest
   hash-cycle planning blocker.)

## 3. Technology choice

- **Language:** TypeScript (strict).
- **Runtime / test runner:** Bun (`bun test`). Available: Bun 1.3.14, Node 24.18.0.
- **Rationale:** The README explicitly names "Bash (a JavaScript/TypeScript layer
  that can emulate bash)" as the agent-friendly target environment; TS aligns with
  that vision. Bun gives fast in-process tests with zero config. Streaming crypto
  and object IO are available via Web Crypto + Node streams.
- **No external dependencies for C0–C4.** Crypto uses the platform Web Crypto API
  (`crypto.subtle`). A minimal test util is hand-rolled. Defer any CLI framework
  until C9 (and prefer keeping it dependency-free).

## 4. In-scope for the first prototype

- Content-addressed blob store with an in-memory backend and a pluggable `Store`
  interface.
- A separate signed ACL/metadata graph layered over content objects.
- Virtual filesystem layer: path-addressed view over a snapshot's blobs; read/write/
  move produce new snapshots; no OS files touched in core operations.
- Working-copy-as-snapshot model: auto-snapshot on command, bookmarks/tags as
  manual pointers, no branches/commits, no index, op-log.
- First-class secret file: per-object encryption at rest, signed access policy
  bound to the graph, key-rotation stub.
- Per-file / per-snapshot visibility states (public, private, embargoed,
  local-only) with **deterministic in-process validation**, a `publish`
  transition, and an `unpublish` (re-privatization) op-log event. This is local
  deterministic simulation, not production/server security (see §2, §5).
- Workspace independence: multiple workspaces over the same ref, no locking,
  conflict-as-data.
- Real-FS materialization adapter (optional) for export/interop.
- **Public export bundle**: a concrete, schema-validated bundle format (defined in
  C6) carrying only public objects + the public manifest, with integrity checks
  and verified absence of private metadata. The CLI `export` command consumes
  this; `import`/`fetch` from a bundle is **deferred** (export-only).
- Thin CLI: `init`, `status`, `snapshot`, `bookmark`, `tag`, `restore`, `export`,
  `publish`, `publish-check`, `unpublish`.
- End-to-end example script + pain-point → feature → chunk mapping table.

## 5. Out-of-scope for the first prototype

Recorded explicitly so the prototype does not over-claim:

- **Server / control plane.** No HTTP/RPC API, no remote authn/authz, no
  server-side enforcement as source of truth. Permission checks run in-process.
  **Explicit scope downgrade:** the delegated context's server-backed privacy
  requirement (context-product-2) is NOT satisfied by this prototype; acceptance
  criteria verify local deterministic simulation only (see §2). A future
  server/control-plane chunk is the upgrade path.
- **Network transfer / fetch / remote peers.** No `fetch` from a remote, no
  networked public-peer transfer. Public-peer visibility is demonstrated
  in-process via the public manifest/bundle, not over a network.
- **Real key management / KMS.** Key material is a local stub; crypto is
  **non-production** until reviewed. No HSM, no key escrow.
- **Real embargo / timed-release guarantees.** Only local staged visibility
  states; no time-based side channels, no distro-maintainer distribution pipeline.
- **Git interop bridge.** No push/pull to real Git remotes, no Git protocol
  compatibility. (Research chunk-6 deferred.) Real-FS export is one-way, best-effort.
- **Multi-user / networked operation.** Single-actor prototype; "unauthorized
  peer" is modeled as a second in-process actor with a different key, not a
  network peer.
- **Production crypto audit, revocation of already-fetched history, metadata
  privacy against a determined traffic-analysis adversary.** Best-effort only.
- **Performance benchmarking on APFS / Apple SSDs.** The architecture avoids the
  small-file-on-real-FS pattern; we do not benchmark it.
- **UI / hosted PR equivalents / collaborative merge UIs.** Merge/diff is minimal
  and public-files-only in this prototype.

## 6. Dependency graph

```
C0 ── C1 ── C2 ── C3 ── C4 ──┬── C6 ──┐
                             │        ├── C9 ── C10
                             └── C7 ──┘
          C5 (depends on C1+C2, parallel with C3/C4)
          C8 (skippable, depends on C6; if landed before C9 enables real-FS export mode; if skipped C9 uses the C6 bundle)
```

Edges:
- C4 fans out to C6 and C7 **independently** (C7 does NOT depend on C6).
- C9 joins C6 and C7 (both must be complete before C9).
- C5 is a side branch off C1+C2; C8 is a skippable branch off C6 (it
  consumes the C6 `PublicManifest`/public projection).

- C0 is the root; nothing may start before C0.
- C1 (object model + ACL graph) depends on C0.
- C2 (in-memory store + Store interface) depends on C1.
- C3 (virtual FS) depends on C2.
- C4 (snapshot working-copy model) depends on C3.
- C5 (secret file) depends on C2 (store) + C1 (ACL graph). May run in parallel
  with C3/C4 **on disjoint files** (see C5 parallel-safety notes).
- C6 (per-file/per-PR privacy) depends on C4 (snapshots) + C5 (secret support).
- C8 (real-FS adapter) depends on C6 (it materializes the C6 public
  projection); **skippable** (see §8 tracker states). If landed before C9,
  C9 `export` may use real-FS materialization; if skipped, C9 `export` uses
  the C6 in-memory public bundle (defined in C6). May run in parallel with
  C7 on disjoint files (C8 depends on C6, so it starts after C6 lands).
- C9 (CLI polish) depends on C4, C6, C7.
- C10 (end-to-end example + mapping) depends on C9.

## 7. Chunks

Each chunk below has: **Scope/owned files**, **Tasks** (checkboxes live in
`checklist.md`), **Verify**, **Dependencies**, **Parallel-safe**, **Blocker /
Deferred**, **Commit expectation**.

---

### C0 — Repo & tooling bootstrap

- **Scope/owned files:** `package.json`, `tsconfig.json`, `bunfig.toml` (if
  needed), `src/index.ts` (library entry), `src/cli/index.ts` (CLI entry stub),
  `tests/smoke.test.ts`, `.gitignore`.
- **Tasks:**
  - [ ] Create `package.json` (type module, scripts: `test`, `build`, `dev`).
  - [ ] Create `tsconfig.json` (strict, ESNext, module resolution bundler).
  - [ ] Create `.gitignore` (`node_modules/`, `dist/`, `.gtw/`).
  - [ ] Add `src/index.ts` exporting a `version` constant.
  - [ ] Add `src/cli/index.ts` with a `gtw --help` stub that prints version.
  - [ ] Add `tests/smoke.test.ts` asserting `version` is defined and `--help`
        exits 0.
- **Verify:** `bun test` passes; `bun run src/cli/index.ts --help` prints version
  and exits 0 on a clean clone.
- **Dependencies:** None (root).
- **Parallel-safe:** No — must land first; everything else imports from `src/`.
- **Blocker/Deferred:** None.
- **Commit expectation:** Single commit `chore: bootstrap gtw ts/bun skeleton`.

---

### C1 — Core object model: content-addressed blobs + signed ACL metadata graph

- **Scope/owned files:** `src/core/object.ts` (blob type, hashing, content-object
  envelope), `src/core/acl.ts` (ACL record, signed metadata graph node),
  `src/core/ids.ts` (hash/id helpers, `SnapshotId` opaque type + framing),
  `src/core/snapshot-contract.ts` (minimal serializable snapshot envelope contract
  for store persistence — **not** the full Snapshot record, which is C4),
  `tests/core/object.test.ts`, `tests/core/acl.test.ts`.
- **Tasks:**
  - [ ] Define `Blob { id: Hash, bytes: Uint8Array }` and content hash function
        (SHA-256 over `blob <len>\0<bytes>`-style framing).
  - [ ] Define a **`ContentObject` envelope** (`{ id: Hash, kind: 'blob' |
        'secret-blob', bytes: Uint8Array }`) so the store (C2) holds a single
        generic typed object rather than blob-only. `Blob` is `kind: 'blob'`;
        C5's `SecretBlob` is `kind: 'secret-blob'` (added additively by C5).
        This makes the store seam secret-aware without C2 knowing crypto.
  - [ ] Define `AclRecord` (subject actor id, object id, permission set) and a
        signed metadata graph node wrapping an `AclRecord` with a signature stub.
  - [ ] Ensure ACL metadata is **separate** from content addressing (two graphs,
        content + ACL overlay) — blobs dedup by content; ACLs layer on top.
  - [ ] Define `SnapshotId` (opaque `Hash`-typed alias) and a minimal
        `SnapshotEnvelope` contract in `src/core/snapshot-contract.ts`: the
        **serialized shape** the store persists for the immutable core snapshot
        payload (`{ id: SnapshotId, parentId: SnapshotId | null,
        serializedBytes: Uint8Array }`). This is a storage contract only — the
        full `Snapshot` record is defined in C4. C4's `Snapshot` has
        `publicManifestRef`/`privateManifestRef` fields, but those refs are
        persisted via C2's separate `ManifestRefs` attachment/index keyed by
        `SnapshotId`, not inside `SnapshotEnvelope.serializedBytes`. C2/C3
        reference `SnapshotId` and `SnapshotEnvelope` without reaching into C4's
        owned files. **`SnapshotId` is the private content-addressed identity of
        the snapshot's core state** — the hash of `parentId`, the tree's
        **canonical tree entries (path + blob id)**, `timestamp`, `message`, and
        the `immutable` flag — and **excludes manifest refs**
        (`publicManifestRef`/`privateManifestRef` are attachments, not identity;
        §2 decision 10). It embeds timestamps, messages, private paths, and
        private blob ids and must **not** appear in public exports; C6 defines
        `PublicProjectionId` (a public-only derivation) for public
        manifests/bundles (§2 decision 8). C1 defines only the opaque
        `SnapshotId` alias and the storage envelope; the **core-state hash
        inputs** (blob ids, timestamp, message, immutable flag) are produced by
        C4 and serialized into `serializedBytes`, so C1 itself does not hash them
        — C4 computes the `SnapshotId` from core state and C1 stores it
        opaquely.
  - [ ] Unit tests: blob store/round-trip/hash-equality; `ContentObject` envelope
        round-trips for both kinds; ACL record round-trips through serialize/parse
        with signature stub verifying; `SnapshotEnvelope` round-trips through
        serialize/parse with `parentId` intact.
- **Verify:** `bun test tests/core/` passes; a blob with identical content
  produces identical ids; a `ContentObject` envelope round-trips for both kinds;
  an ACL record survives serialize/parse with signature intact; a
  `SnapshotEnvelope` round-trips with `parentId` intact.
- **Dependencies:** C0.
- **Parallel-safe:** Yes, with C5 **only if** it does not edit C1-owned
  files. C1 owns `src/core/object.ts`, `src/core/acl.ts`, `src/core/ids.ts`,
  and `src/core/snapshot-contract.ts` exclusively. C5 may add
  `src/core/secret-blob.ts` (a new file) but must not edit those four C1-owned
  files. (C8 now depends on C6, so it is not parallel with C1.)
- **Blocker/Deferred:** Signature is a stub (HMAC over a local key); real signing
  deferred. Revocation semantics deferred to C6 (best-effort, see §2 decision 3).
- **Commit expectation:** `feat(core): content-addressed blobs and signed ACL graph`.

---

### C2 — Pluggable Store interface + in-memory backend
- **Scope/owned files:** `src/store/store.ts` (Store interface/traits +
  `ManifestRefs` attachment contract), `src/store/memory-store.ts` (in-memory
  impl, including the manifest-ref index), `tests/store/memory-store.test.ts`.
- **Tasks:**
  - [ ] Define `Store` interface operating on the C1 contracts:
        `putObject(obj: ContentObject)`, `getObject(id: Hash): ContentObject`,
        `hasObject(id: Hash): boolean`, `putAcl`, `getAcl`,
        `putSnapshot(env: SnapshotEnvelope)`, `getSnapshot(id: SnapshotId):
        SnapshotEnvelope`, `listSnapshots(): SnapshotId[]`.
        (Blobs and secret blobs flow through the same `putObject/getObject` seam
        via the `ContentObject` envelope; the store is crypto-agnostic.) Define
        `ManifestRefs = { publicManifestRef: Hash | null; privateManifestRef:
        Hash | null }` plus `putManifestRefs(snapshotId: SnapshotId, refs:
        ManifestRefs)` and `getManifestRefs(snapshotId: SnapshotId):
        ManifestRefs`. The manifest-ref record is a separate mutable
        attachment/index keyed by `SnapshotId`; `putManifestRefs` is an upsert,
        `getManifestRefs` returns stored refs or both `null`, and the attachment
        is not content-addressed and is not part of `SnapshotEnvelope` bytes.
  - [ ] Implement `MemoryStore` satisfying `Store` using `Map`s, with separate
        maps for immutable content/ACL/snapshot envelopes and the mutable
        manifest-ref attachment index.
  - [ ] Tests: store/retrieve `ContentObject` of both kinds; ACL round-trip;
        `SnapshotEnvelope` round-trip; missing-object returns a typed `NotFound`
        error, not `undefined`; duplicate `putSnapshot` of the same envelope is
        idempotent; `putSnapshot` with the same `SnapshotId` but different core
        `serializedBytes` is rejected with a typed conflict; `putManifestRefs`
        upserts changed `publicManifestRef`/`privateManifestRef` values for the
        same `SnapshotId`, repeating the same refs is idempotent, and the
        associated `SnapshotEnvelope` bytes are unchanged. **No delete tests** —
        deletion/GC is deferred (content-addressed stores are append-only in this
        prototype; see §5).
- **Verify:** `bun test tests/store/` passes; no real-FS writes occur (assert by
  running in a temp cwd and checking no files created outside `.gtw`); immutable
  snapshot-envelope puts are idempotent/conflict-detected while manifest-ref
  attachment upserts can change refs for the same `SnapshotId`.
- **Dependencies:** C1.
- **Parallel-safe:** Yes, owns `src/store/` exclusively. C3 depends on this; do not
  start C3 until C2 lands.
- **Blocker/Deferred:** Real-FS backend is C8, not here. **Deletion/GC is deferred** —
  content-addressed objects and immutable snapshot envelopes are append-only;
  the separate manifest-ref attachment index is the only mutable upsert surface
  and has no delete method. A future GC chunk may add tombstoned deletion.
- **Commit expectation:** `feat(store): pluggable Store interface and in-memory backend`.

---
### C3 — Virtual filesystem layer over snapshot blobs
- **Scope/owned files:** `src/vfs/vfs.ts` (path-addressed view over blobs),
  `src/vfs/ops.ts` (read/write/move/remove producing new `VirtualTree`s),
  `tests/vfs/vfs.test.ts`.
- **Tasks:**
  - [ ] Define `VirtualTree` as a path → blob-id map plus parent `SnapshotId`
        (the `SnapshotId` opaque type comes from C1's `src/core/ids.ts`; C3 does
        **not** construct `Snapshot` records — that is C4).
  - [ ] Implement `read`, `write`, `move`, `remove` that return a **new**
        `VirtualTree` (immutable; no mutation of the input). These ops produce
        new `VirtualTree`s, **not** persisted snapshots — C4 wraps a `VirtualTree`
        into a `Snapshot` and persists it via the store.
  - [ ] Ensure no OS files are touched (all blob reads/writes go through `Store`).
  - [ ] Tests: mutate a virtual tree → assert resulting `VirtualTree` content
        (path→blob-id map); round-trip write→read→move→read; remove a missing
        path raises a typed error. Do **not** assert snapshot persistence here
        (that is C4).
- **Verify:** `bun test tests/vfs/` passes; a test that mutates a virtual tree
  asserts resulting content without touching disk (spy on `Store`, assert no
  real-FS calls).
- **Dependencies:** C2.
- **Parallel-safe:** Yes, owns `src/vfs/` exclusively. C4 depends on this.
- **Blocker/Deferred:** Directory semantics (empty-dir tracking) may be simplified
  to path-prefix-only; record if so.
- **Commit expectation:** `feat(vfs): immutable virtual filesystem over snapshot blobs`.

---

### C4 — Snapshot working-copy model (JJ-style)

- **Scope/owned files:** `src/snapshot/snapshot.ts` (Snapshot record: parent id,
  timestamp, message, **opaque manifest refs** `publicManifestRef: Hash | null`
  and `privateManifestRef: Hash | null`, immutable marker — C4 does **not** know
  the concrete `PublicManifest`/private-manifest schemas, which are owned by C6;
  the refs are opaque content hashes C4 stores and round-trips through the
  Store `ManifestRefs` attachment/index without interpreting),
  `src/snapshot/bookmark.ts` (named pointers),
  `src/snapshot/oplog.ts` (operation log),
  `src/workspace/working-copy.ts` (working-copy-as-snapshot, auto-snapshot),
  `tests/snapshot/snapshot.test.ts`, `tests/workspace/working-copy.test.ts`.
- **Tasks:**
  - [ ] Define the full `Snapshot` record (parent id, timestamp, message,
        `publicManifestRef: Hash | null`, `privateManifestRef: Hash | null`,
        immutable flag) in `src/snapshot/snapshot.ts`, building on the
        `SnapshotId`/`SnapshotEnvelope` storage contract from C1. **`SnapshotId`
        is computed from the snapshot's core state only** — `parentId`, the
        **canonical tree entries (path + blob id)**, `timestamp`, `message`, and
        the `immutable` flag — and **excludes `publicManifestRef`/
        `privateManifestRef`**, which are manifest-ref attachments, not identity
        (§2 decision 10). C4 owns `computeSnapshotId(coreState)` and computes the
        `SnapshotId` when it builds a `Snapshot`; manifest refs are attached
        afterward without changing the id. The manifest fields are **opaque
        content-hash references**, not embedded manifest objects: C4 creates
        fresh snapshots with both refs `null`, stores/round-trips whatever
        `Hash | null` values are present via the Store `ManifestRefs`
        attachment/index keyed by `SnapshotId`, and **does not parse, validate,
        or construct** a `PublicManifest` or private-manifest schema. C4
        serializes only the immutable core snapshot payload into
        `SnapshotEnvelope.serializedBytes` and persists it via
        `Store.putSnapshot`; C4 persists/loads refs through
        `Store.putManifestRefs`/`Store.getManifestRefs` (defaulting missing refs
        to `null`). C4 exports a `Snapshot.withManifestRefs(public, private)`
        helper that returns a new `Snapshot` with the supplied manifest-ref
        hashes and the **same `SnapshotId`** (manifest refs are not identity), so
        C6 can populate refs without editing C4-owned files, without re-hashing
        the snapshot, and without replacing the immutable snapshot envelope.
  - [ ] Implement bookmarks/tags as named pointers to snapshot ids; moving a
        bookmark appends an op-log event instead of silently rewriting.
  - [ ] Implement working-copy-as-snapshot: auto-snapshot on command boundary;
        no index/staging; no "current branch".
  - [ ] Implement op-log replacing reflog.
  - [ ] Tests: mutate a file → run a no-op command → assert a new snapshot exists
        with both manifest refs `null` (C4 creates snapshots with null manifest
        refs; C6 populates them later through C4's owned API without editing
        C4-owned files); bookmark move appends op-log; invalid snapshot id
        rejected; a snapshot round-trips through C4 save/load with
        `publicManifestRef`/`privateManifestRef` preserved verbatim via the
        Store `ManifestRefs` attachment (including non-null `Hash` values C4
        does not interpret). **SnapshotId identity-stability tests (§2 decision
        10):** (a) build a `Snapshot` with fixed core state, then call
        `Snapshot.withManifestRefs(pub, priv)` with several distinct non-null
        `Hash` pairs and assert the `SnapshotId` is **unchanged** — manifest refs
        are not identity; (b) change any one of `parentId`, a tree entry's path
        or blob id, `timestamp`, `message`, or the `immutable` flag and assert
        the `SnapshotId` **does** change — **including a path-only rename/move
        where every blob id is unchanged** (tree identity is the canonical
        `(path, blobId)` set, so moving `a.txt` → `b.txt` with the same blob id
        changes the `SnapshotId`); (c) two snapshots with identical core state
        but different manifest refs share the same `SnapshotId`; (d) persisting
        new refs for that same `SnapshotId` upserts only the `ManifestRefs`
        attachment, leaves `SnapshotEnvelope.serializedBytes` unchanged, and a
        reload sees the latest refs. These tests prove the manifest hash cycle is
        broken at the identity and persistence layers, and must pass **without C6
        present**.
- **Verify:** `bun test tests/snapshot/ tests/workspace/` passes; auto-snapshot
  produces a new snapshot id with both manifest refs `null`; op-log records
  bookmark moves; a snapshot round-trips through save/load with
  `publicManifestRef`/`privateManifestRef` preserved verbatim (C4 treats them as
  opaque `Hash | null`, never parsing manifest contents); **changing only
  manifest refs does not change the `SnapshotId`, while changing
  parent/tree-entry-(path-or-blob-id)/timestamp/message/immutable-flag does (a
  path-only rename/move with unchanged blob ids changes the `SnapshotId`)** (§2
  decision 10); manifest-ref upserts update only the `ManifestRefs` attachment
  for the same `SnapshotId` and leave `SnapshotEnvelope.serializedBytes`
  unchanged. C4 tests must pass **without C6 present** (no import of any
  `src/policy/` or `src/export/` symbol).
- **Dependencies:** C3.
- **Parallel-safe:** Yes, owns `src/snapshot/` and `src/workspace/working-copy.ts`.
  C7 depends on this. C6 depends on this but must **not** edit C4-owned files:
  C6 populates `publicManifestRef`/`privateManifestRef` by calling C4's owned
  `Snapshot.withManifestRefs(public, private)` helper exported from
  `src/snapshot/snapshot.ts` — which returns a `Snapshot` with the new ref hashes
  and the **same `SnapshotId`** (manifest refs are not identity; §2 decision 10)
  — and then upserts the Store `ManifestRefs` attachment from C6-owned
  policy/export code instead of replacing the immutable snapshot envelope.
  Coordinate with C5/C6 if they touch workspace files.
- **Blocker/Deferred:** Auto-rebase of descendants is **deferred** (jj feature);
  record as deferred. Conflict-as-data objects are introduced minimally in C7.
- **Commit expectation:** `feat(snapshot): working-copy-as-snapshot with bookmarks and op-log`.

---

### C5 — First-class secret file (per-object encryption at rest)

- **Scope/owned files:** `src/crypto/secret.ts` (encrypt/decrypt, key stub),
  `src/crypto/policy.ts` (signed access policy bound to graph),
  `src/core/secret-blob.ts` (encrypted blob type), `tests/crypto/secret.test.ts`.
- **Tasks:**
  - [ ] Define `SecretBlob { id: Hash, ciphertext: Uint8Array, policyId: Hash }`
        in `src/core/secret-blob.ts`, distinct from plain `Blob`. The
        `ciphertext` field is a **self-describing framed ciphertext** laid out as
        `version(1) || algId(1) || iv(12) || ciphertext(N) || tag(16)` (i.e.
        `iv || ciphertext || tag` with a one-byte `version` and one-byte
        `algorithm` discriminator prefix), so decryption is implementable from the
        stored bytes alone — the nonce/IV and GCM auth tag are persisted inside
        `ciphertext`; no external IV field is needed. It serializes into a
        `ContentObject` envelope with `kind: 'secret-blob'` (the envelope type is
        defined in C1's `src/core/object.ts`; C5 adds the `SecretBlob` type and
        the `'secret-blob'` kind constructor but does **not** edit C1's owned
        files — it imports the envelope type and constructs values of the
        already-open `kind` union). Ciphertext is stored via `Store.putObject`;
        plaintext is never stored.
  - [ ] Implement encrypt/decrypt using Web Crypto (AES-GCM; random 12-byte IV
        per object; 16-byte auth tag; key from local key stub). Expose
        `encryptSecret(plaintext, policyId, keyStub) → SecretBlob` (produces the
        framed `version || algId || iv || ciphertext || tag` bytes) and
        `decryptSecret(blob, keyStub) → plaintext` (parses the framing, extracts
        the iv and tag, and verifies the GCM auth tag; a tag mismatch under the
        wrong key surfaces as the typed `Denied` error).
  - [ ] Bind access policy to the signed ACL graph (C1), not a user-editable config.
  - [ ] Key rotation stub: rotating a key produces a new policy; content encrypted
        under the new key produces `SecretBlob`s with the new `policyId`.
  - [ ] Tests (low-level crypto + store seam, **not** commit/snapshot integration
        since C5 does not depend on C3/C4): `encryptSecret` → assert ciphertext
        (not plaintext) in the returned `SecretBlob` → `Store.putObject` it →
        `Store.getObject` returns the same ciphertext → `decryptSecret` with the
        authorized key stub returns the original plaintext → `decryptSecret` with
        an unauthorized/different key stub raises a typed `Denied` error and
        returns **no plaintext**; rotate key → new `policyId` → old-key stub
        cannot decrypt content encrypted under the new key. **Framing /
        round-trip-from-stored-bytes tests:** assert the framed `ciphertext`
        parses to the recorded `version`/`algorithm`/`iv`/`tag`; assert
        `decryptSecret` succeeds using **only** the bytes returned by
        `Store.getObject` (no out-of-band IV); assert two encryptions of the same
        plaintext under the same key yield different `iv`s and different
        `ciphertext` bytes (random IV); assert a tampered tag byte causes
        `decryptSecret` to raise `Denied` (auth-tag integrity); assert key
        rotation denial survives the store round-trip (content encrypted under
        the new key, retrieved via `getObject`, cannot be decrypted with the old
        key stub).
- **Verify:** `bun test tests/crypto/` passes; raw store bytes for a secret blob
  do not contain the plaintext substring; unauthorized read returns `Denied`.
- **Parallel-safe:** Yes, owns `src/crypto/` and `src/core/secret-blob.ts`. C5
  may add `src/core/secret-blob.ts` but must not edit the C1-owned files
  (`src/core/object.ts`, `src/core/acl.ts`, `src/core/ids.ts`,
  `src/core/snapshot-contract.ts`). The `ContentObject` envelope and
  its `kind: 'blob' | 'secret-blob'` union are defined in C1; C5 imports the
  envelope type and constructs `kind: 'secret-blob'` values — no C1 file edits
  needed. The store seam (`Store.putObject/getObject`) is defined in C2 and is
  already secret-aware via the envelope, so C5 needs no store edits.
- **Blocker/Deferred:** **Crypto is non-production.** Key material is a local stub;
  no KMS, no HSM. Revocation of already-fetched history is best-effort (§2
  decision 3). Metadata privacy (file name visibility) is enforced by C6, not here.
- **Commit expectation:** `feat(crypto): first-class encrypted secret blobs with signed access policy`.

---

### C6 — Per-file / per-PR privacy + visibility states

- **Scope/owned files:** `src/policy/visibility.ts` (public/private/embargoed/
  local-only states), `src/policy/authorize.ts` (authorization checks),
  `src/policy/publish.ts` (publish + unpublish transitions),
  `src/export/public-manifest.ts` (public manifest + **public export bundle**,
  with an explicit schema excluding private bytes **and private metadata**),
  `tests/policy/visibility.test.ts`, `tests/policy/publish.test.ts`,
  `tests/export/public-manifest.test.ts`.
- **Tasks:**
  - [ ] Define visibility states `public | private | embargoed | local-only` at
        file and snapshot/ref level.
  - [ ] Implement deterministic authorization checks for read/checkout/publish.
  - [ ] Implement `publish` transition: private/embargoed → public, recorded in
        op-log; no time-based side channel.
  - [ ] Implement `unpublish` (re-privatization) transition: public → private,
        recorded as a **new** op-log event (§2 decision 7). It flips visibility
        for *future* readers; it does **not** recall already-exported content.
        The op-log remains append-only.
  - [ ] Define and enforce the **visibility state-operation matrix** in
        `src/policy/visibility.ts` + `src/policy/authorize.ts`. The matrix is
        evaluated at both the **file** level and the **snapshot/ref** level. For
        each state the allowed/denied operations are fixed and deterministic
        (**no time-based behavior** — the clock is never consulted):
        | state | read (owner) | read (other/peer) | public export/bundle | publish transition |
        |---|---|---|---|---|
        | `public` | allowed | allowed | included | n/a (already public) |
        | `private` | allowed (authorized) | denied → `Denied` | omitted | `publish` → `public` |
        | `embargoed` | allowed (owner) | denied → `Denied` | omitted | `publish` → `public` (explicit only; **no time-based auto-release**) |
        | `local-only` | allowed (owner-local only) | denied → `Denied` | omitted | rejected (no `publish` from `local-only`) |
        At the snapshot/ref level the same matrix applies: a `private` ref is
        absent from the public manifest/bundle; an `embargoed` ref is
        public-denied until an explicit `publish` op-log event; a `local-only`
        ref is owner-local and rejected from `publish`/`export`. Authorization is
        deterministic in-process (§2). (Resolves the visibility-state-dispatch
        adversarial finding.)
  - [ ] Define and build the **public manifest** with an explicit schema. The
        public manifest is a serializable record containing **only**:
        `bundleVersion: 1`, `publicProjectionIds: PublicProjectionId[]`
        (canonical public-projection snapshot ids derived **only** from public
        entries and public metadata — never full private `SnapshotId` values,
        which embed timestamps, messages, private paths, and private blob ids and are therefore
        private; `SnapshotId` excludes manifest refs per §2 decision 10),
        `publicEntries: { path: string, blobId: Hash }[]` (public files only),
        `publicManifestHash: Hash` (integrity self-hash, **deterministic**: computed over the canonical manifest payload with the `publicManifestHash` field itself **omitted** — equivalently, the field is set to a fixed `null`/zero placeholder before hashing and the hash is written into that field afterward). `PublicProjectionId` is
        defined in this chunk as
        `hash(bundleVersion || canonical(publicEntries) || canonical(publicProjectionIds-of-nearest-public-visible-ancestors))`.
        Parent projection ids are the **nearest public-visible ancestor**
        projection ids, computed by eliding private-only and public-noop
        snapshots from the parent chain (a snapshot is *public-noop* if its
        public entries and its public-visible parents are unchanged from its
        predecessor). When a snapshot's public entries and public-visible
        parents are unchanged from its nearest public-visible ancestor, it
        **reuses that ancestor's `PublicProjectionId`** instead of minting a
        new one. This is a deterministic function of public data only, so two
        snapshots with identical public entries but different private-only
        history produce identical projection ids. `publicManifestHash` is
        computed over the canonical serialization of **only** the public fields
        above (with `publicManifestHash` itself omitted / set to the fixed
        `null`/zero placeholder) and therefore excludes private refs, timestamps,
        messages, private-only snapshots, **and its own value** — this is what
        makes the self-hash deterministic and reproducible by a verifier.
        The manifest must **not** contain: full `SnapshotId` values, private
        manifest refs, private blob/secret ids, private paths, private sizes,
        private timestamps/change-timing, op-log entries, or private messages.
        The private manifest (separate) holds the private counterparts and the
        `SnapshotId` → `PublicProjectionId` mapping. Because `SnapshotId` excludes
        manifest refs (§2 decision 10), the `SnapshotId` is final before the
        private manifest is built; the private manifest's content hash can be
        written back into `privateManifestRef` without changing the `SnapshotId`,
        so the `SnapshotId → PublicProjectionId` mapping has **no fixed-point
        cycle**.
  - [ ] Define and build the **public export bundle**: `{ manifest:
        PublicManifest, objects: ContentObject[] (public blobs only) }` with an
        integrity check (on load, recompute `publicManifestHash` over the **same
        canonical payload used at build time — `publicManifestHash` omitted / set
        to the fixed `null`/zero placeholder** — and verify it equals the stored
        value; a tampered manifest or a hash computed with a different
        omit/null rule fails). The bundle is what `gtw export` emits; `import`/`fetch` from a
        bundle is deferred (export-only). This is the C9 `export` fallback when
        C8 (real-FS) is skipped.
  - [ ] **Populate the C4 snapshot manifest refs from C6-owned code.** C6 owns
        the concrete `PublicManifest` and private-manifest schemas and the
        build/load/export logic. After building a public manifest (and its
        private counterpart), C6 computes their content hashes, calls C4's owned
        snapshot-update API (e.g. `Snapshot.withManifestRefs(publicHash,
        privateHash)` exported from `src/snapshot/snapshot.ts`) to produce a
        same-id snapshot value, and persists the refs by upserting the Store
        `ManifestRefs` attachment keyed by that `SnapshotId` (e.g.
        `Store.putManifestRefs(snapshot.id, { publicManifestRef: publicHash,
        privateManifestRef: privateHash })`) — all from `src/policy/`/
        `src/export/` code. C6 **must not edit** any C4-owned file
        (`src/snapshot/snapshot.ts`, `src/snapshot/bookmark.ts`,
        `src/snapshot/oplog.ts`, `src/workspace/working-copy.ts`); it only
        imports the helper C4 exports and uses the C2 store attachment API. C4's
        helper treats the hashes as opaque `Hash | null`, does not interpret
        them, and **preserves the `SnapshotId`** (manifest refs are not identity;
        §2 decision 10). The mutable attachment upsert is the planned same-id
        persistence path; C6 must not replace `SnapshotEnvelope.serializedBytes`
        to change manifest refs.
  - [ ] Tests: create a private PR-equivalent → public peer sees only public
        subset → `publish` → visibility flips without re-clone; `unpublish` after
        `publish` → future public peer sees it as private again, op-log has two
        events; attempt to publish without transition is rejected with a clear
        error. **Visibility state-operation matrix tests** (file and
        snapshot/ref level, every state): `public` → readable by other peer and
        present in export; `private` → authorized owner reads, other peer gets
        `Denied`, absent from public export; `embargoed` → owner reads, other
        peer gets `Denied`, absent from export, **no time-based release**
        (advancing a mock clock does not change visibility; only an explicit
        `publish` flips it); `local-only` → owner-local reads, other peer gets
        `Denied`, omitted from export, and `publish`/`export` of a `local-only`
        ref is rejected with a clear error. **Public-export metadata-absence
        tests** (assert each class): no private file contents (zero private
        bytes), no private path strings, no private blob/secret ids, no private
        manifest refs, no private sizes, no private timestamps/change-timing, no
        op-log entries, no private messages, **and no full `SnapshotId` values**
        (only `PublicProjectionId`s appear). **Public-projection determinism
        test**: two snapshots with **identical public entries** but **different
        private-only history** (different private files, timestamps, messages,
        and private manifest refs) produce **identical** `PublicProjectionId`s,
        identical public manifests, and identical public export bundle hashes.
        **Parent-leak / private-history-elision test** (C6): build
        `public A -> private-only P -> public B` where B has the **same public
        entries** as A (P is a private-only snapshot with no public entries and
        is elided from the public-visible parent chain). Assert B's
        `PublicProjectionId`, public manifest, and public export bundle hash are
        **identical** to the no-private-history case (`public A -> public B'`
        with the same public entries as A) — i.e. the private-only P snapshot
        leaves no trace in B's public projection. Bundle integrity check passes
        on a valid bundle and fails on a tampered manifest. **`publicManifestHash`
        determinism test**: build a manifest, then recompute `publicManifestHash`
        independently over the canonical payload with the field omitted (or set
        to the fixed `null`/zero placeholder) and assert it equals the stored
        value; recompute with the field left as its own stored hash (not omitted)
        and assert that **does not** equal the stored value — proving the self-hash
        uses the omit/null rule and is reproducible by a verifier that does not
        trust the stored hash. **Manifest-hash-cycle
        / acyclic-mapping test (§2 decision 10):** build a snapshot, compute its
        `SnapshotId` (final, excludes manifest refs), build the public + private
        manifests (the private manifest maps `SnapshotId → PublicProjectionId`),
        compute their content hashes, write them back with
        `Snapshot.withManifestRefs`, persist them by upserting the Store
        `ManifestRefs` attachment, and assert (a) the `SnapshotId` is
        **unchanged** after the write-back, (b) the immutable
        `SnapshotEnvelope.serializedBytes` is unchanged, (c) the private
        manifest's `SnapshotId → PublicProjectionId` mapping is well-defined with
        no fixed-point dependence on `privateManifestRef`, and (d) re-running the
        whole manifest-build + attachment upsert produces the same `SnapshotId`
        and the same manifest hashes (idempotent, deterministic, acyclic).
- **Verify:** `bun test tests/policy/ tests/export/` passes; an export from a repo
  with a private file contains zero bytes of private content **and** zero private
  path strings, zero private blob/secret ids, zero private manifest refs, zero
  private sizes, zero private timestamps, zero op-log entries, zero private
  messages, **and zero full `SnapshotId` values**; bundle integrity check passes
  on valid bundles and fails on tampered manifests; **`publicManifestHash` is
  deterministic — recomputing it over the canonical payload with the field
  omitted / set to the fixed `null`/zero placeholder reproduces the stored value,
  and a verifier using the same omit/null rule accepts while a verifier using a
  different rule (e.g. hashing the field's own stored value) rejects**;
  `unpublish` after `publish` re-privatizes for future readers while the op-log
  stays append-only; the visibility state-operation matrix holds for every state
  at file and snapshot/ref level; identical public entries with different
  private-only history yield identical public manifests/bundle hashes; the
  `public A -> private-only P -> public B` (same public entries as A)
  parent-leak case matches the `public A -> public B'` no-private-history case;
  **writing manifest refs back with `Snapshot.withManifestRefs` and the Store
  `ManifestRefs` attachment upsert does not change the `SnapshotId`, does not
  replace `SnapshotEnvelope.serializedBytes`, and leaves the private manifest's
  `SnapshotId → PublicProjectionId` mapping acyclic (idempotent re-build yields
  the same id and manifest hashes)** (§2 decision 10).
- **Dependencies:** C4 (snapshots) + C5 (secret support).
- **Parallel-safe:** Yes, owns `src/policy/`, `src/export/public-manifest.ts`,
  and `tests/export/public-manifest.test.ts`. C6 owns the concrete
  `PublicManifest`/private-manifest schemas and the build/load/export logic and
  populates a snapshot's `publicManifestRef`/`privateManifestRef` by calling
  C4's owned `Snapshot.withManifestRefs` helper exported from
  `src/snapshot/snapshot.ts` (which preserves the `SnapshotId` — manifest refs
  are not identity; §2 decision 10) and then upserting the C2 Store
  `ManifestRefs` attachment keyed by `SnapshotId` — C6 **must not edit** any
  C4-owned file (`src/snapshot/snapshot.ts`, `src/snapshot/bookmark.ts`,
  `src/snapshot/oplog.ts`, `src/workspace/working-copy.ts`). C9 depends on this
  for `publish`, `publish-check`, `unpublish`, and `export`.
- **Blocker/Deferred:** Real embargo timing and distro-maintainer distribution are
  out-of-scope (§5). Revocation is best-effort. `unpublish` cannot recall
  already-exported content (§2 decision 7). Bundle `import`/`fetch` is deferred
  (export-only).
- **Commit expectation:** `feat(policy): file-level visibility states and publish transition`.

---

### C7 — Workspace independence (no worktree hijacking)

- **Scope/owned files:** `src/workspace/workspace.ts` (workspace id, current
  snapshot/ref pointer, isolation), `src/workspace/conflict.ts` (conflict-as-data
  minimal), `tests/workspace/independence.test.ts`.
- **Tasks:**
  - [ ] Track workspace ids and their current snapshot/ref pointers independently
        of ref ownership.
  - [ ] Allow multiple workspaces to check out the same snapshot/ref concurrently
        with no locking.
  - [ ] Minimal conflict-as-data: when two workspaces diverge on the same logical
        ref, record a resolvable conflict object, not a lock error.
  - [ ] Tests: two workspaces attached to the same store both operate on the same
        ref; assert neither is blocked; divergence produces a conflict object, not
        a lock error.
- **Verify:** `bun test tests/workspace/independence.test.ts` passes; two
  workspaces mutate independently with zero lock errors.
- **Dependencies:** C4.
- **Parallel-safe:** Yes, owns `src/workspace/workspace.ts` and
  `src/workspace/conflict.ts`. Do not edit `src/workspace/working-copy.ts` (C4) —
  add new files. Coordinate with C4 if the workspace interface needs extending.
- **Blocker/Deferred:** Full jj-style auto-rebase of descendants is deferred.
- **Commit expectation:** `feat(workspace): independent workspaces with conflict-as-data`.

---

### C8 — Real-FS materialization adapter (skippable compat)

- **Scope/owned files:** `src/store/fs-store.ts` (optional real-FS backend),
  `src/vfs/materialize.ts` (virtual tree → real files), `tests/vfs/materialize.test.ts`.
  **Skippable:** if skipped, mark it `[~]` in the checklist (see §8 tracker states)
  and C9 `export` falls back to the in-memory public bundle (defined in C6).
  **Export privacy invariant:** `gtw export` is **always** produced from the C6
  `PublicManifest`/public export bundle. C8 may **only** materialize the
  C6-filtered public projection (the public entries + public blobs from the
  C6 bundle) to real files; it must **never** materialize the raw snapshot or
  the unfiltered `VirtualTree`. C8's `materialize` input is the C6 public
  projection, not the private `Snapshot`/`VirtualTree`.
- **Tasks:**
  - [ ] Implement `materialize(publicProjection, targetDir)` writing the C6
        public projection's public blobs to real files (one-way, best-effort).
        The input is the C6-filtered public projection, **not** the raw
        `Snapshot` or unfiltered `VirtualTree`.
  - [ ] Optional `FsStore` backend implementing the `Store` interface against a
        `.gtw/objects` directory.
  - [ ] Tests: export a snapshot's public projection to a temp dir → assert
        byte-identical content for public files; corrupt-object detection on
        read. **Export-privacy tests (real-FS mode):** assert the materialized
        temp dir contains **no** private/local-only bytes, **no** private path
        strings, **no** private blob/secret ids, **no** full `SnapshotId`
        values, and **no** private metadata (private manifest refs, private
        timestamps, op-log entries, private messages) — only the C6 public
        projection's public entries appear on disk.
- **Verify:** `bun test tests/vfs/materialize.test.ts` passes; exported files
  match the C6 public projection content; a corrupted object file is detected;
  the materialized real-FS output contains zero private/local-only bytes, paths,
  blob/secret ids, `SnapshotId`s, and private metadata.
- **Dependencies:** C6 (it materializes the C6 public projection). C2 + C3
  are transitive via C6. **Skippable** (see §8 tracker states): if skipped,
  C9 `export` uses the C6 in-memory public bundle. If landed before C9,
  C9 `export` may use real-FS materialization.
- **Parallel-safe:** Yes, parallel with C7 on disjoint files (C8 depends on
  C6, so it starts only after C6 lands; it is no longer parallel with C4–C6).
  Owns `src/store/fs-store.ts` and `src/vfs/materialize.ts` (new files; do
  not edit `src/store/store.ts` or `src/vfs/vfs.ts`).
- **Blocker/Deferred:** This is the **secondary** path; in-memory remains primary.
  Git interop (push/pull) is out-of-scope (§5).
- **Commit expectation:** `feat(fs): optional real-FS materialization adapter`.

---

### C9 — Thin CLI polish

- **Scope/owned files:** `src/cli/commands/*.ts` (init, status, snapshot, bookmark,
  tag, restore, export, publish, publish-check, unpublish), `src/cli/index.ts` (dispatch),
  `tests/cli/cli.test.ts`.
- **Tasks:**
  - [ ] Implement `init`, `status`, `snapshot create/show/list`, `bookmark list/set`,
        `tag create/list`, `restore`, `export`, `publish`, `publish-check`, and
        `unpublish` as thin wrappers over the library core. `export` is **always** produced
        from the C6 `PublicManifest`/public export bundle — in both the C8
        landed case (C8 materializes the C6 public projection to real files)
        and the C8-skipped case (C9 emits the C6 in-memory public bundle). The
        raw snapshot/`VirtualTree` is never exported. There is **no `fetch`
        command** — public-peer visibility is demonstrated in-process via the
        public manifest/bundle, not network transfer (§5).
  - [ ] Keep CLI thin — no business logic in commands.
  - [ ] Integration tests using temp directories (or in-memory stores) covering
        the full **`snapshot create → tag create → publish → export →
        publish-check → unpublish`** flow (a flow made only of planned commands; no `fetch`).
        **Export-privacy tests are gated on the C8 status line in the
        checklist (§8):** the **bundle-mode** export-privacy tests **always
        run** — assert the C6 in-memory public bundle (the C8-skipped path)
        contains **no** private/local-only bytes, **no** private path strings,
        **no** private blob/secret ids, **no** full `SnapshotId` values, and
        **no** private metadata (private manifest refs, private timestamps,
        op-log entries, private messages); only C6 public-projection public
        entries appear. The **real-FS export/materialization CLI tests run
        only when C8 status is `[x]`** (C8 landed): assert the
        C8-materialized real-FS tree contains the same zero-private-metadata
        invariants. When C8 status is `[~]` (skipped), C9 asserts **bundle
        mode only** and must remain green without exercising any real-FS
        materialization path.
- **Verify:** `bun test tests/cli/` passes; `gtw --help` lists all commands in the
  documented order, including `publish` before `publish-check` and `unpublish`;
  a temp-dir integration test runs the full `snapshot create → tag create →
  publish → export → publish-check → unpublish` flow end-to-end. **Bundle-mode
  export-privacy tests always pass.** When C8 status is `[x]`, real-FS
  export/materialization CLI tests also pass and the materialized tree contains
  zero private/local-only bytes, paths, blob/secret ids, `SnapshotId`s, and
  private metadata. When C8 status is `[~]`, only bundle-mode is asserted and the
  suite is green.
- **Dependencies:** C4, C6, C7. C8 is **skippable** and depends on C6: if
  C8 status is `[x]` (landed before C9), `export` may materialize to real
  files via C8 and the real-FS CLI tests run; if C8 status is `[~]`
  (skipped), `export` emits the C6 in-memory public bundle and only
  bundle-mode tests run. Either way C9 is implementable and green.
- **Parallel-safe:** No — this is the integration layer; land after C4/C6/C7.
- **Blocker/Deferred:** `import`/`fetch` from a bundle is **deferred**
  (export-only for the prototype). There is no `fetch` command and no network
  transfer (§5).
- **Commit expectation:** `feat(cli): thin command surface over the gtw core`.

---

### C10 — End-to-end example & pain-point mapping

- **Scope/owned files:** `examples/demo.ts` (end-to-end script), `docs/plan/
  pain-point-mapping.md` (mapping table), update to `README.md` (link to example,
  no product claims).
- **Tasks:**
  - [ ] Write `examples/demo.ts` exercising all six pain points: commit a secret
        `.env`, private file, private PR → publish → unpublish, snapshot+tag
        workflow, two workspaces on same ref, in-memory operation with no real-FS
        clone. The demo is a **local deterministic simulation** — it must not
        claim production/server security (§2, §5).
  - [ ] Write `docs/plan/pain-point-mapping.md` mapping each pain point → feature
        → chunk(s).
  - [ ] Add a pointer from `README.md` to the example (no endorsement claims).
  - [ ] Assert the example runs green.
- **Verify:** `bun run examples/demo.ts` exits 0 and prints a pain-point-by-pain-
  point success summary; mapping table covers all six pain points.
- **Dependencies:** C9.
- **Parallel-safe:** No — final integration chunk.
- **Blocker/Deferred:** None for the prototype. Production hardening is out-of-scope.
- **Commit expectation:** `docs: end-to-end demo and pain-point mapping`.

## 8. Resume protocol

To resume implementation deterministically:

1. Read `docs/plan/checklist.md` to find the first unchecked task.
2. Read the corresponding chunk in `docs/plan/plan.md` (§7) for scope, owned
   files, dependencies, and verification.
3. Confirm dependencies are met (all chunks the current one depends on are checked
   off `[x]` **or** marked skipped `[~]` in the checklist — see tracker states
   below). **C8 skip control:** the checklist carries an explicit **C8 chunk
   status line** (`- [ ] C8 status: not started` / `- [~] C8 status: skipped` /
   `- [x] C8 status: complete`). To intentionally skip C8 and use the C6
   public-bundle fallback, set that status line to `[~]`; this single line
   controls C8's skipped-dependency/resume semantics for all downstream chunks
   (C9 `export` then uses the C6 in-memory public bundle). The individual C8
   task boxes below the status line remain unchecked `[ ]` (or `[~]` per the
   chosen protocol) and do not separately gate resume — the **status line** is
   the authoritative skip marker.
4. Implement only the owned files listed; do not edit files owned by other chunks
   unless coordinating via the parallel-safety notes.
5. Run the chunk's **Verify** command(s). They must pass before checking off.
6. Commit with the chunk's **Commit expectation** message.
7. Update `docs/plan/checklist.md` (check the boxes) and continue to the next
   dependency-ready chunk.

### Tracker states (checklist.md)

Each chunk line uses one of three states so resume is deterministic:

- `[ ]` — **not started** (default; the resume target).
- `[x]` — **complete** (Verify passed; commit landed).
- `[~]` — **intentionally skipped** (only valid for chunks explicitly marked
  skippable in this plan, i.e. C8). A `[~]` chunk counts as "dependency met" for
  downstream chunks, and the plan must document the fallback that replaces it
  (for C8: C9 `export` falls back to the C6 in-memory public bundle). A skipped
  chunk may be revisited later by flipping `[~]` back to `[ ]`. For C8 the
  authoritative skip marker is the **C8 chunk status line** in the checklist
  (see step 3 above); the individual C8 task boxes do not separately gate
  resume.

If a chunk's assumptions are invalidated, update §2 (assumptions) or §5
(out-of-scope) in this file with rationale before proceeding.

## 9. Verification strategy summary

- **Unit tests** per module (`bun test tests/<area>/`).
- **Integration tests** for the CLI and the end-to-end demo.
- **No gates/formatters/build** are run as part of this planning task. The
  implementer runs `bun test` per chunk; project-wide lint/build is set up in C0
  but not enforced during planning.
- **Behavior, not plumbing:** tests assert visibility outcomes (the full
  state-operation matrix at file and snapshot/ref level), encryption outcomes
  (framed-ciphertext round-trip from stored bytes, auth-tag integrity, key
  rotation denial), workspace independence, snapshot identity (**`SnapshotId`
  excludes manifest refs: changing only manifest refs does not change the id,
  changing core state does; the private manifest's `SnapshotId →
  PublicProjectionId` mapping is acyclic** — §2 decision 10), **public-export
  metadata absence (all private metadata classes, including full `SnapshotId`
  values)**, public-projection id determinism (identical public entries →
  identical public manifests/bundle hashes regardless of private-only history),
  bundle integrity, and publish/unpublish op-log behavior — the things that can
  actually break and that demonstrate the pain points via local deterministic
  simulation.
