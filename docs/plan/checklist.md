# Tracker — "Git that Theo wants" (gtw) first prototype

> Companion to `docs/plan/plan.md`. Check boxes as chunks complete. Resume from
> the first unchecked task (see `plan.md` §8 Resume protocol, incl. tracker
> states `[ ]` not-started / `[x]` complete / `[~]` intentionally skipped).

## Repository state at planning time

- [x] Confirmed: repo contains only `README.md` + `.git`; single commit
      `72c90de` on `master`.
- [x] Confirmed: **no existing durable plan/tracker** (this is the first).
- [x] Confirmed: **no implementation started** (all chunks below unchecked).

## Dependency graph (quick reference)

```
C0 ── C1 ── C2 ── C3 ── C4 ──┬── C6 ──┐
                             │        ├── C9 ── C10
                             └── C7 ──┘
          C5 (depends on C1+C2, parallel with C3/C4)
          C8 (skippable, depends on C6; if landed before C9 enables real-FS export mode; if skipped C9 uses the C6 bundle)
```
C7 depends only on C4 (NOT C6); C9 joins C6+C7; C8 is a skippable branch off C6 (it consumes the C6 `PublicManifest`/public projection).

## Chunks

### C0 — Repo & tooling bootstrap
- [x] Create `package.json` (type module, scripts: `test`, `build`, `dev`)
- [x] Create `tsconfig.json` (strict, ESNext, module resolution bundler)
- [x] Create `.gitignore` (`node_modules/`, `dist/`, `.gtw/`)
- [x] Add `src/index.ts` exporting a `version` constant
- [x] Add `src/cli/index.ts` with a `gtw --help` stub that prints version
- [x] Add `tests/smoke.test.ts` asserting `version` is defined and `--help` exits 0
- **Verify:** `bun test` passes; `bun run src/cli/index.ts --help` prints version and exits 0
- **Deps:** none (root) · **Parallel-safe:** no (must land first)
- **Blocker/Deferred:** none
- **Commit:** `chore: bootstrap gtw ts/bun skeleton`

### C1 — Core object model: content-addressed blobs + signed ACL metadata graph
- [x] Define `Blob { id, bytes }` and content hash (SHA-256, framed)
- [x] Define `ContentObject` envelope (`{ id, kind: 'blob'|'secret-blob', bytes }`) — store seam is secret-aware without crypto
- [x] Define `AclRecord` and signed metadata graph node (signature stub)
- [x] Keep ACL metadata separate from content addressing (two graphs)
- [x] Define `SnapshotId` (opaque Hash alias, **private content-addressed identity of the snapshot's core state** — hash of `parentId`, **canonical tree entries (path + blob id)**, `timestamp`, `message`, `immutable` flag; **excludes manifest refs** per §2 decision 10; tree identity is the canonical `(path, blobId)` set so a path-only rename/move changes the id even with unchanged blob ids; embeds timestamps/messages/private paths/private blob ids so never in public exports; C4 computes the id from core state, C1 stores it opaquely) + minimal `SnapshotEnvelope` storage contract (`{ id, parentId, serializedBytes }`) in `src/core/snapshot-contract.ts` (storage shape only; full `Snapshot` is C4; `PublicProjectionId` for public exports is defined in C6 per §2 decision 8)
- [x] Unit tests: blob round-trip/hash-equality; `ContentObject` envelope round-trips both kinds; ACL serialize/parse with signature; `SnapshotEnvelope` round-trips with `parentId` intact
- **Verify:** `bun test tests/core/` passes; identical content → identical ids; `ContentObject` envelope round-trips both kinds; ACL survives round-trip; `SnapshotEnvelope` round-trips with `parentId` intact
- **Deps:** C0 · **Parallel-safe:** yes with C5 if it does not edit C1-owned files; C1 owns `src/core/object.ts`, `src/core/acl.ts`, `src/core/ids.ts`, `src/core/snapshot-contract.ts` exclusively; C5 may add `src/core/secret-blob.ts` (new file) but must not edit those four C1-owned files (C8 now depends on C6, so it is not parallel with C1)
- **Blocker/Deferred:** signature is a stub (HMAC local key); real signing deferred. Revocation semantics deferred to C6.
- **Commit:** `feat(core): content-addressed blobs and signed ACL graph`

### C2 — Pluggable Store interface + in-memory backend
- [x] Define `Store` interface on C1 contracts: `putObject/getObject/hasObject` (ContentObject envelope, crypto-agnostic), `putAcl/getAcl`, `putSnapshot/getSnapshot/listSnapshots` (immutable `SnapshotEnvelope`), plus `putManifestRefs/getManifestRefs` for a separate mutable `ManifestRefs { publicManifestRef: Hash | null; privateManifestRef: Hash | null }` attachment/index keyed by `SnapshotId`
- [x] Implement `MemoryStore` using `Map`s
- [x] Tests: store/retrieve `ContentObject` both kinds; ACL round-trip; `SnapshotEnvelope` round-trip; missing → typed `NotFound`; duplicate `putSnapshot` of same envelope idempotent; same `SnapshotId` with different core `serializedBytes` rejected; `putManifestRefs` updates changed refs for the same `SnapshotId`, repeating same refs is idempotent, and the snapshot envelope bytes remain unchanged. **No delete tests** (append-only; GC deferred)
- **Verify:** `bun test tests/store/` passes; no real-FS writes; immutable snapshot-envelope puts are idempotent/conflict-detected while manifest-ref attachment upserts can change refs for the same `SnapshotId`
- **Deps:** C1 · **Parallel-safe:** yes, owns `src/store/`; C3 waits for this
- **Blocker/Deferred:** real-FS backend is C8; **deletion/GC deferred** (content-addressed objects and snapshot envelopes are append-only; the manifest-ref attachment index is the sole mutable upsert surface and has no delete method)
- **Commit:** `feat(store): pluggable Store interface and in-memory backend`

### C3 — Virtual filesystem layer over snapshot blobs
- [x] Define `VirtualTree` (path → blob-id map + parent `SnapshotId` from C1's `src/core/ids.ts`; C3 does NOT construct `Snapshot` records — that is C4)
- [x] Implement `read/write/move/remove` returning new immutable `VirtualTree` (not persisted snapshots; C4 wraps into `Snapshot`)
- [x] No OS files touched (all blob IO via `Store`)
- [x] Tests: mutate tree → assert resulting `VirtualTree` content (path→blob-id map); round-trip; remove-missing raises typed error. Do NOT assert snapshot persistence (C4)
- **Verify:** `bun test tests/vfs/` passes; spy on `Store` asserts no real-FS calls
- **Deps:** C2 · **Parallel-safe:** yes, owns `src/vfs/`; C4 waits for this
- **Blocker/Deferred:** directory semantics may simplify to path-prefix-only (record if so)
- **Commit:** `feat(vfs): immutable virtual filesystem over snapshot blobs`

### C4 — Snapshot working-copy model (JJ-style)
- [x] Define full `Snapshot` record (parent id, timestamp, message, **opaque manifest refs** `publicManifestRef: Hash | null` + `privateManifestRef: Hash | null`, immutable flag) in `src/snapshot/snapshot.ts`, building on C1's `SnapshotId`/`SnapshotEnvelope`. **`SnapshotId` = hash of core state only (`parentId`, **canonical tree entries (path + blob id)**, `timestamp`, `message`, `immutable` flag) and excludes manifest refs** (§2 decision 10); tree identity is the canonical `(path, blobId)` set (sorted by path), so a path-only rename/move changes the `SnapshotId` even when every blob id is unchanged; `SnapshotEnvelope.serializedBytes` stores only immutable core snapshot state. Manifest refs are **opaque content hashes** persisted through Store's mutable `ManifestRefs` attachment/index keyed by `SnapshotId`: C4 stores/round-trips `publicManifestRef: Hash | null` / `privateManifestRef: Hash | null` opaquely, does not parse/validate/construct concrete manifest schemas, and `Snapshot.withManifestRefs(public, private)` preserves the same `SnapshotId`
- [x] Implement bookmarks/tags as named pointers; move appends op-log event
- [x] Implement working-copy-as-snapshot: auto-snapshot on command boundary; no index; no current branch
- [x] Implement op-log replacing reflog
- [x] Tests: mutate → no-op command → new snapshot exists with both manifest refs `null`; bookmark move → op-log; invalid snapshot id rejected; snapshot save/load round-trips `publicManifestRef`/`privateManifestRef` preserved verbatim through the Store `ManifestRefs` attachment (incl. non-null `Hash` values C4 does not interpret). **SnapshotId identity-stability (§2 decision 10):** `withManifestRefs` with distinct non-null `Hash` pairs leaves `SnapshotId` unchanged; changing `parentId`/tree-entry-(path-or-blob-id)/`timestamp`/`message`/`immutable`-flag changes it — **including a path-only rename/move where every blob id is unchanged**; identical core state + different manifest refs → same `SnapshotId`; upserting changed refs for the same `SnapshotId` changes only the attachment, not the immutable envelope
- **Verify:** `bun test tests/snapshot/ tests/workspace/` passes; auto-snapshot yields new id with both manifest refs `null`; op-log records moves; manifest refs round-trip verbatim as opaque `Hash | null`; **changing only manifest refs does not change `SnapshotId`, changing core state (incl. a path-only rename/move with unchanged blob ids) does** (§2 decision 10); manifest-ref upserts update only the attachment for the same `SnapshotId`, not the immutable snapshot envelope
- **Deps:** C3 · **Parallel-safe:** yes, owns `src/snapshot/` + `src/workspace/working-copy.ts`; C6 depends on this but must **not** edit C4-owned files — C6 populates `publicManifestRef`/`privateManifestRef` via C4's exported `Snapshot.withManifestRefs` helper and Store `putManifestRefs` from C6-owned code; coordinate with C5/C6
- **Blocker/Deferred:** auto-rebase of descendants deferred; conflict-as-data introduced minimally in C7
- **Commit:** `feat(snapshot): working-copy-as-snapshot with bookmarks and op-log`

### C5 — First-class secret file (per-object encryption at rest)
- [x] Define `SecretBlob { id, ciphertext, policyId }` in `src/core/secret-blob.ts`; `ciphertext` is **self-describing framed** as `version(1) || algId(1) || iv(12) || ciphertext(N) || tag(16)` (iv + GCM auth tag persisted inside the bytes; no external IV field); serializes into `ContentObject` envelope `kind: 'secret-blob'` (envelope defined in C1; C5 imports it, no C1 edits); stored via `Store.putObject`
- [x] Implement `encryptSecret`/`decryptSecret` (Web Crypto AES-GCM, random 12-byte IV, 16-byte auth tag, local key stub); `encryptSecret` produces framed `version||algId||iv||ciphertext||tag` bytes; `decryptSecret` parses framing, extracts iv+tag, verifies GCM auth tag (tag mismatch → typed `Denied`)
- [x] Bind access policy to signed ACL graph (C1), not user-editable config
- [x] Key rotation stub: new policyId under new key for new content
- [x] Tests (low-level crypto+store, NOT commit/snapshot — C5 does not require C3/C4): `encryptSecret` → ciphertext (no plaintext) → `Store.putObject` → `Store.getObject` returns same ciphertext → `decryptSecret` with authorized key → plaintext; unauthorized key → typed `Denied`, no plaintext; rotate key → old key cannot decrypt new content. **Framing/round-trip-from-stored-bytes tests**: framed `ciphertext` parses to recorded version/alg/iv/tag; `decryptSecret` succeeds using **only** `getObject` bytes (no out-of-band IV); two encryptions of same plaintext under same key → different iv/ciphertext (random IV); tampered tag byte → `Denied` (auth-tag integrity); key-rotation denial survives store round-trip
- **Verify:** `bun test tests/crypto/` passes; raw store bytes contain no plaintext substring; unauthorized read returns `Denied`
- **Deps:** C2 + C1 (does **not** require C3/C4) · **Parallel-safe:** yes, owns `src/crypto/` + `src/core/secret-blob.ts`; C5 may add `src/core/secret-blob.ts` but must not edit the C1-owned files (`src/core/object.ts`, `src/core/acl.ts`, `src/core/ids.ts`, `src/core/snapshot-contract.ts`); `ContentObject` envelope + `kind` union are C1's; store seam is C2's — no store edits needed
- **Blocker/Deferred:** **crypto is non-production**; no KMS/HSM; revocation of fetched history is best-effort; metadata privacy enforced in C6
- **Commit:** `feat(crypto): first-class encrypted secret blobs with signed access policy`

### C6 — Per-file / per-PR privacy + visibility states
- [x] Define visibility states `public | private | embargoed | local-only` (file + snapshot/ref level) AND the **state-operation matrix** (no time-based behavior): `public` → readable by other peer + present in export; `private` → authorized owner reads, other peer `Denied`, omitted from export, `publish`→`public`; `embargoed` → owner reads, other peer `Denied`, omitted from export, `publish`→`public` (explicit only, **no time-based auto-release**); `local-only` → owner-local reads, other peer `Denied`, omitted from export, `publish`/`export` rejected
- [x] Implement deterministic authorization checks (read/checkout/publish)
- [x] Implement `publish` transition (private/embargoed → public, op-log recorded; no time side channel)
- [x] Implement `unpublish` (re-privatization): public → private as a NEW op-log event (§2 decision 7); flips visibility for future readers; cannot recall already-exported content; op-log stays append-only
- [x] Define public manifest with explicit schema: `{ bundleVersion:1, publicProjectionIds: PublicProjectionId[], publicEntries[{path,blobId}], publicManifestHash }`. `publicManifestHash` is a **deterministic self-hash** computed over the canonical manifest payload with the `publicManifestHash` field itself **omitted** (equivalently, set to a fixed `null`/zero placeholder before hashing, then written into that field afterward); `PublicProjectionId` is derived only from public entries and nearest public-visible ancestor projection ids, with private-only/public-noop snapshots elided
- [x] **Populate C4 snapshot manifest refs from C6-owned code** via `Snapshot.withManifestRefs(public, private)` and Store `putManifestRefs`, without replacing `SnapshotEnvelope.serializedBytes` or editing C4-owned files
- [x] Tests: private PR → public peer sees only public subset → publish → visibility flips → unpublish → future public peer sees private again; publish-without-transition rejected; state-operation matrix covered for every state; metadata-absence tests cover private bytes, paths, blob/secret ids, manifest refs, sizes, timestamps, op-log entries, messages, and full `SnapshotId` values; public-projection determinism, parent-leak elision, bundle integrity, publicManifestHash determinism, and acyclic manifest-ref mapping are covered
- **Verify:** `bun test tests/policy/ tests/export/` passes; export has zero private bytes, paths, blob/secret ids, manifest refs, sizes, timestamps, op-log entries, messages, **and zero full `SnapshotId` values**; state-operation matrix holds for every state at file + snapshot/ref level (incl. no time-based embargo release); identical public entries + different private-only history → identical public manifests/bundle hashes; `public A -> private-only P -> public B` (same public entries as A) parent-leak case matches no-private-history `public A -> public B'`; bundle integrity passes/fails correctly; `publicManifestHash` recomputes with the omit/null rule; unpublish re-privatizes for future readers, op-log append-only; **manifest refs written via `Snapshot.withManifestRefs` + Store `ManifestRefs` upsert do not change `SnapshotId` or replace `SnapshotEnvelope.serializedBytes`, and the private manifest's `SnapshotId → PublicProjectionId` mapping is acyclic/idempotent** (§2 decision 10)
- **Deps:** C4 + C5 · **Parallel-safe:** yes, owns `src/policy/` + `src/export/public-manifest.ts` + `tests/export/public-manifest.test.ts`; C6 owns concrete `PublicManifest`/private-manifest schemas + build/load/export and populates snapshot manifest refs via C4's `Snapshot.withManifestRefs` helper plus Store `putManifestRefs` — **must not edit** C4-owned files (`src/snapshot/*`, `src/workspace/working-copy.ts`); C9 depends on this for `publish`/`publish-check`/`unpublish`/`export`
- **Blocker/Deferred:** real embargo timing + distro-maintainer distribution out-of-scope; revocation best-effort; `unpublish` cannot recall already-exported content; bundle `import`/`fetch` deferred (export-only)
- **Commit:** `feat(policy): file-level visibility states and publish transition`

### C7 — Workspace independence (no worktree hijacking)
- [x] Track workspace ids + current snapshot/ref pointers independent of ref ownership
- [x] Allow concurrent checkout of same snapshot/ref with no locking
- [x] Minimal conflict-as-data: divergence → resolvable conflict object, not lock error
- [x] Tests: two workspaces on same ref; neither blocked; divergence → conflict object, not lock error
- **Verify:** `bun test tests/workspace/independence.test.ts` passes; two workspaces mutate independently with zero lock errors
- **Deps:** C4 · **Parallel-safe:** yes, owns `src/workspace/workspace.ts` + `src/workspace/conflict.ts`; do not edit `src/workspace/working-copy.ts`
- **Blocker/Deferred:** full jj-style auto-rebase of descendants deferred
- **Commit:** `feat(workspace): independent workspaces with conflict-as-data`

### C8 — Real-FS materialization adapter (skippable compat)
- [x] **C8 status: complete** — authoritative skip marker (see plan.md §8). C8 landed, so downstream C9 real-FS export/materialization tests must run.
- [x] Implement `materialize(publicProjection, targetDir)` (C6 public projection → real files, one-way). Input is the C6-filtered public projection, **not** the raw `Snapshot`/`VirtualTree`. **Export privacy invariant:** `gtw export` is always produced from the C6 `PublicManifest`/public export bundle; C8 may only materialize the C6-filtered public projection, never the raw snapshot/`VirtualTree`
- [x] Optional `FsStore` backend against `.gtw/objects`
- [x] Tests: export snapshot's public projection to temp dir → byte-identical content for public files; corrupt-object detection. **Export-privacy tests (real-FS mode):** materialized temp dir contains **no** private/local-only bytes, **no** private path strings, **no** private blob/secret ids, **no** full `SnapshotId` values, **no** private metadata (private manifest refs, private timestamps, op-log entries, private messages) — only C6 public-projection public entries appear on disk
- **Verify:** `bun test tests/vfs/materialize.test.ts` passes; exported files match C6 public projection; corrupted object detected; materialized real-FS output contains zero private/local-only bytes, paths, blob/secret ids, `SnapshotId`s, and private metadata
- **Blocker/Deferred:** secondary path (in-memory primary); Git interop out-of-scope; skippable per §8 tracker states
- **Commit:** `feat(fs): optional real-FS materialization adapter`
- **Deps:** C6 (materializes the C6 public projection; C2+C3 transitive via C6) · **Parallel-safe:** yes with C7 on disjoint files (starts after C6 lands; not parallel with C4–C6)

### C9 — Thin CLI polish
- [ ] Implement `init`, `status`, `snapshot create/show/list`, `bookmark list/set`, `tag create/list`, `restore`, `export`, `publish`, `publish-check`, `unpublish` (thin wrappers). `export` is **always** produced from the C6 `PublicManifest`/public export bundle — both C8 landed (C8 materializes C6 public projection to real files) and C8 skipped (C9 emits C6 in-memory public bundle); raw snapshot/`VirtualTree` is never exported. **No `fetch` command** — public-peer visibility is in-process via public manifest (§5)
- [ ] Integration tests (temp dirs or in-memory stores) covering **`snapshot create → tag create → publish → export → publish-check → unpublish`** (planned commands only; no `fetch`). **Export-privacy tests are gated on the C8 status line (§8):** **bundle-mode** export-privacy tests **always run** — C6 in-memory public bundle (C8-skipped path) contains **no** private/local-only bytes, **no** private path strings, **no** private blob/secret ids, **no** full `SnapshotId` values, **no** private metadata (private manifest refs, private timestamps, op-log entries, private messages); only C6 public-projection public entries appear. **Real-FS export/materialization CLI tests run only when C8 status is `[x]`** (C8 landed) — assert the C8-materialized real-FS tree holds the same zero-private-metadata invariants. When C8 status is `[~]`, C9 asserts **bundle mode only** and stays green without exercising any real-FS materialization path.
- **Verify:** `bun test tests/cli/` passes; `gtw --help` lists all commands in documented order, including `publish` before `publish-check` and `unpublish`; temp-dir integration test runs `snapshot create → tag create → publish → export → publish-check → unpublish` end-to-end. **Bundle-mode export-privacy tests always pass.** When C8 status is `[x]`, real-FS export/materialization CLI tests also pass and the materialized tree contains zero private/local-only bytes, paths, blob/secret ids, `SnapshotId`s, and private metadata. When C8 status is `[~]`, only bundle-mode is asserted and the suite is green.
- **Deps:** C4, C6, C7 (C8 skippable, depends on C6: if C8 status `[x]` `export` may use real-FS and real-FS CLI tests run; if `[~]` `export` emits C6 bundle and only bundle-mode tests run) · **Parallel-safe:** no (integration layer)
- **Blocker/Deferred:** `import`/`fetch` from bundle deferred (export-only); no `fetch` command, no network transfer (§5)
- **Commit:** `feat(cli): thin command surface over the gtw core`

### C10 — End-to-end example & pain-point mapping
- [ ] Write `examples/demo.ts` exercising all six pain points (secret `.env`, private file, private PR → publish → unpublish, snapshot+tag, two workspaces same ref, in-memory no real-FS clone). Demo is a **local deterministic simulation** — no production/server security claims (§2, §5)
- [ ] Write `docs/plan/pain-point-mapping.md` (pain point → feature → chunk(s))
- [ ] Add pointer from `README.md` to example (no endorsement claims)
- [ ] Assert example runs green
- **Verify:** `bun run examples/demo.ts` exits 0 and prints pain-point-by-pain-point success; mapping table covers all six pain points
- **Deps:** C9 · **Parallel-safe:** no (final integration)
- **Blocker/Deferred:** none for prototype; production hardening out-of-scope
- **Commit:** `docs: end-to-end demo and pain-point mapping`

## Out-of-scope for this prototype (do not implement)

- Server / control plane / remote authn/authz / server-side enforcement. **Explicit scope downgrade:** delegated server-backed privacy requirement is NOT satisfied; acceptance verifies local deterministic simulation only (§2). Future server chunk is the upgrade path
- Network transfer / fetch / remote peers. No `fetch` command, no networked public-peer transfer; public-peer visibility is in-process via public manifest/bundle
- Store deletion / GC (append-only; no delete methods; GC deferred to a future chunk)
- Real KMS / HSM / key escrow; production crypto audit
- Real embargo / timed-release guarantees; distro-maintainer distribution
- Git interop bridge (push/pull to real Git remotes); real-FS export is one-way
- Multi-user networked operation (unauthorized peer modeled as in-process actor)
- Revocation of already-fetched history (best-effort only)
- Metadata privacy against determined traffic-analysis adversary (best-effort)
- APFS / Apple SSD benchmarking
- UI / hosted PR equivalents / collaborative merge UIs
- Auto-rebase of descendants (jj feature, deferred)
