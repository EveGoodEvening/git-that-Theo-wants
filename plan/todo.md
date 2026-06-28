# Implementation Todo / Checklist: Git that Theo Wants

This checklist is written for a coding agent implementing the prototype from scratch. Follow phases in order. Do not skip acceptance gates; later phases assume earlier invariants are true.

Primary target stack: TypeScript, Node.js, pnpm, SQLite, local CLI first, optional HTTP sync server second.

## 0. Ground rules for the implementation agent

- [ ] Treat `design.md` as the source of truth for architecture and terminology.
- [ ] Keep the codename as `tg` in commands and code unless the repository owner chooses another name.
- [ ] Do not imply Theo endorsement anywhere in package metadata, README, CLI output, docs, or UI.
- [ ] Build local-first functionality before server functionality.
- [ ] Add tests in the same phase as each feature.
- [ ] Every object format must include an explicit `format` version.
- [ ] Every path that enters the system must pass canonical path normalization.
- [ ] Every public publish/export path must run projection safety checks.
- [ ] Never write plaintext private blobs into `.tg/objects`.
- [ ] Recompute changed paths server-side; never trust a client-provided changed-path list.
- [ ] Prefer small, composable modules over a monolithic VCS class.

## 1. Repository bootstrap

### 1.1 Create project skeleton

- [ ] Initialize package manager.
  - [ ] Run `pnpm init`.
  - [ ] Add TypeScript config.
  - [ ] Add Vitest config.
  - [ ] Add ESLint or equivalent static checks if desired.
- [ ] Create source tree:

```text
src/
  cli/
    index.ts
    commands/
  core/
  storage/
  crypto/
  policy/
  repo/
  vfs/
  workspace/
  sync/
  server/
  mr/
  release/
  git/
  tests/
```

- [ ] Add `bin` entry in `package.json` for `tg`.
- [ ] Add scripts:
  - [ ] `pnpm test`
  - [ ] `pnpm typecheck`
  - [ ] `pnpm lint` if linter is configured
  - [ ] `pnpm build`
- [ ] Add a minimal CLI command:
  - [ ] `tg --version`
  - [ ] `tg help`

### 1.2 Add shared utilities

- [ ] Implement `src/core/result.ts`.
  - [ ] Define `Result<T, E>` or choose exception-based style consistently.
  - [ ] Add helper methods for success/failure.
- [ ] Implement `src/core/errors.ts`.
  - [ ] Add typed error codes listed in `design.md`.
  - [ ] Include machine-readable `code`, human `message`, and optional `details`.
- [ ] Implement `src/core/ids.ts`.
  - [ ] Define branded TypeScript types for object IDs, revision IDs, change IDs, policy IDs, user IDs, group IDs, workspace IDs.
  - [ ] Add ID constructors.
  - [ ] Add validators.

### 1.3 Acceptance gate

- [ ] `pnpm typecheck` passes.
- [ ] `pnpm test` passes with at least one smoke test.
- [ ] `tg --version` runs from a local checkout.

## 2. Canonical paths and object encoding

### 2.1 Path normalization

- [ ] Implement `src/policy/path.ts` or `src/core/path.ts`.
- [ ] Function: `normalizeRepoPath(input: string): RepoPath`.
- [ ] Requirements:
  - [ ] Convert path separators to `/`.
  - [ ] Remove duplicate separators.
  - [ ] Reject absolute OS paths.
  - [ ] Reject `.` and `..` segments.
  - [ ] Reject empty path unless representing repository root.
  - [ ] Normalize Unicode to one selected form.
  - [ ] Reject NUL bytes.
  - [ ] Reject Windows drive prefixes.
  - [ ] Reject paths that would collide under case-insensitive mode unless repo config allows them.
- [ ] Add tests for:
  - [ ] `src/index.ts`
  - [ ] `./src/index.ts`
  - [ ] `src//index.ts`
  - [ ] `../secret`
  - [ ] `/etc/passwd`
  - [ ] `C:\Users\x\file`
  - [ ] Unicode normalization collision.

### 2.2 Canonical JSON

- [ ] Implement `src/core/canonical.ts`.
- [ ] Function: `canonicalize(value: unknown): Uint8Array`.
- [ ] Requirements:
  - [ ] Stable key ordering.
  - [ ] Stable number/string/boolean/null representation.
  - [ ] Reject `undefined`, functions, symbols, NaN, Infinity.
  - [ ] No incidental whitespace.
- [ ] Add `hashCanonical(value): Hash` using SHA-256.
- [ ] Add tests proving object key order does not change the hash.

### 2.3 Object envelope

- [ ] Implement `src/core/objects.ts`.
- [ ] Define `ObjectType` union:
  - [ ] `blob`
  - [ ] `tree`
  - [ ] `revision`
  - [ ] `change`
  - [ ] `bookmark`
  - [ ] `tag`
  - [ ] `policy`
  - [ ] `projection`
  - [ ] `keyGrant`
  - [ ] `mergeRequest`
  - [ ] `releaseGate`
  - [ ] `operation`
  - [ ] `conflict`
- [ ] Define `ObjectEnvelope`.
- [ ] Implement `encodeObjectEnvelope`.
- [ ] Implement `decodeObjectEnvelope`.
- [ ] Implement `computeObjectId`.
- [ ] Enforce encrypted-object ID rule: hash encrypted envelope payload, not plaintext.
- [ ] Add schema validators for every object type, even if some are stubs.

### 2.4 Acceptance gate

- [ ] Path tests pass.
- [ ] Canonicalization tests pass.
- [ ] Object envelope round-trip tests pass.
- [ ] Corrupt object payload fails validation.

## 3. Local storage

### 3.1 File object store

- [ ] Implement `src/storage/objectStore.ts` interface.

```ts
interface ObjectStore {
  has(id: ObjectId): Promise<boolean>;
  get(id: ObjectId): Promise<ObjectEnvelope>;
  put(envelope: ObjectEnvelope): Promise<void>;
  batchGet(ids: ObjectId[]): Promise<ObjectEnvelope[]>;
  batchPut(envelopes: ObjectEnvelope[]): Promise<void>;
}
```

- [ ] Implement `src/storage/fileObjectStore.ts`.
- [ ] Store objects under `.tg/objects/sha256/<first-two>/<id>.obj`.
- [ ] Write atomically:
  - [ ] write to temp file;
  - [ ] fsync if practical;
  - [ ] rename into final path.
- [ ] Verify object ID before writing.
- [ ] Reject hash mismatch.
- [ ] Add tests for put/get/has/batch.

### 3.2 SQLite metadata store

- [ ] Implement `src/storage/sqlite.ts`.
- [ ] Add migrations directory.
- [ ] Create migrations for tables:
  - [ ] `objects`
  - [ ] `revisions`
  - [ ] `changes`
  - [ ] `bookmarks`
  - [ ] `policies`
  - [ ] `key_grants`
  - [ ] `operations`
  - [ ] `workspaces`
  - [ ] `merge_requests`
  - [ ] `release_gates`
- [ ] Add migration runner.
- [ ] Add repository transaction helper.
- [ ] Add tests for fresh DB creation and migration idempotence.

### 3.3 Repo initialization

- [ ] Implement `src/repo/init.ts`.
- [ ] `tg init` creates `.tg/` layout.
- [ ] Write `repo.json`.
- [ ] Write `config.json`.
- [ ] Initialize SQLite.
- [ ] Create default policy:
  - [ ] owner has all actions;
  - [ ] public has no access unless explicitly enabled.
- [ ] Create empty root tree object.
- [ ] Create initial revision.
- [ ] Create `main` bookmark pointing to initial revision.
- [ ] Record init operation.

### 3.4 Repo open/discovery

- [ ] Implement `src/repo/open.ts`.
- [ ] Discover `.tg` by walking parent directories.
- [ ] Load config and DB.
- [ ] Fail with clear error outside a repo.
- [ ] Add `tg repo info` or include info in `tg status`.

### 3.5 Acceptance gate

- [ ] `tg init` creates a valid repo.
- [ ] `tg status` in a fresh repo reports clean state.
- [ ] Re-running `tg init` in an existing repo fails safely.
- [ ] Object store and DB metadata agree for initial objects.

## 4. Core blob/tree/revision model

### 4.1 Blob creation

- [ ] Implement public blob creation from bytes.
- [ ] Implement blob object validation.
- [ ] Store byte length and executable flag.
- [ ] Add tests for small and large blobs.

### 4.2 Tree creation

- [ ] Implement tree builder from normalized paths.
- [ ] Sort entries canonically.
- [ ] Deduplicate identical subtrees.
- [ ] Reject duplicate paths.
- [ ] Reject invalid modes.
- [ ] Add tests for nested directories.

### 4.3 Revision creation

- [ ] Implement `createRevision`.
- [ ] Inputs:
  - [ ] parents;
  - [ ] root tree;
  - [ ] policy id;
  - [ ] change id;
  - [ ] author;
  - [ ] message;
  - [ ] visibility.
- [ ] Compute revision ID from canonical payload.
- [ ] Insert revision metadata into DB.
- [ ] Add tests for deterministic revision IDs.

### 4.4 Tree walking

- [ ] Implement `walkTree(revisionId)`.
- [ ] Implement `getEntry(revisionId, path)`.
- [ ] Implement `listEntries(revisionId, path)`.
- [ ] Add tests for tree traversal.

### 4.5 Acceptance gate

- [ ] A revision can be created and read back.
- [ ] Tree traversal returns expected files.
- [ ] Two identical trees produce the same object ID.
- [ ] Different contents produce different object IDs.

## 5. Snapshot from real directory

### 5.1 File scanner

- [ ] Implement scanner that reads the working directory while excluding `.tg/`.
- [ ] Respect ignore config later; for v0 use a simple internal ignore list:
  - [ ] `.tg/`
  - [ ] `.git/`
  - [ ] `node_modules/` unless explicitly included.
- [ ] Compute file hashes.
- [ ] Detect executable bit where available.
- [ ] Build tree from scanned files.
- [ ] Add tests using temp directories.

### 5.2 `tg snapshot`

- [ ] Implement `src/repo/snapshot.ts`.
- [ ] `tg snapshot -m "message"`:
  - [ ] scans working directory;
  - [ ] creates blobs/trees;
  - [ ] creates or updates current change;
  - [ ] creates new revision;
  - [ ] records operation;
  - [ ] updates workspace state.
- [ ] If no message is provided, use current change description or fail with actionable message.
- [ ] Add `--visibility` option with default from repo config.

### 5.3 `tg status`

- [ ] Implement status diff between workspace base and current filesystem.
- [ ] Output added/modified/deleted files.
- [ ] Show encrypted/private tracked files after crypto phase; for now show regular files only.
- [ ] Exit code 0 for clean, 1 for dirty only if `--porcelain` or configured.

### 5.4 Acceptance gate

- [ ] Create repo, add file, run `tg status`, see added file.
- [ ] Run `tg snapshot -m "add file"`, status becomes clean.
- [ ] Modify file, status shows modified.
- [ ] Delete file, status shows deleted.
- [ ] `.tg/` is never snapshotted.

## 6. Diff engine

### 6.1 Tree diff

- [ ] Implement `src/repo/diff.ts`.
- [ ] Compare two tree roots.
- [ ] Classify added, deleted, modified, mode-changed.
- [ ] Add rename detection later; for v0 optional.
- [ ] Add summary counts.

### 6.2 Text diff

- [ ] Add line-based diff for UTF-8 text blobs.
- [ ] Detect binary blobs.
- [ ] Do not print binary data.
- [ ] Add tests for text modifications.

### 6.3 `tg diff`

- [ ] Support `tg diff` for workspace vs base.
- [ ] Support `tg diff REV_A REV_B`.
- [ ] Support `--stat`.
- [ ] Support `--name-only`.

### 6.4 Acceptance gate

- [ ] Diff output is deterministic.
- [ ] Binary files do not dump bytes.
- [ ] Diff between identical revisions is empty.

## 7. Changes, bookmarks, tags, and operation log

### 7.1 Change lifecycle

- [ ] Implement `src/repo/changes.ts`.
- [ ] Create stable `changeId` for new work.
- [ ] Store current revision for each change.
- [ ] Amend/snapshot keeps same `changeId`.
- [ ] `tg new [REV_OR_BOOKMARK]` starts new change from target.
- [ ] `tg describe -m "..."` updates current change title/message.

### 7.2 Bookmarks

- [ ] Implement `src/repo/bookmarks.ts`.
- [ ] Commands:
  - [ ] `tg bookmark list`
  - [ ] `tg bookmark create NAME REV`
  - [ ] `tg bookmark move NAME REV`
  - [ ] `tg bookmark delete NAME`
- [ ] Bookmarks must not move implicitly when `tg new` creates a change.
- [ ] Record bookmark moves in operation log.

### 7.3 Tags

- [ ] Implement immutable tags.
- [ ] Commands:
  - [ ] `tg tag list`
  - [ ] `tg tag create NAME REV`
- [ ] Reject attempts to recreate or move a tag.

### 7.4 Operation log and undo

- [ ] Implement `src/repo/log.ts`.
- [ ] Record operations for:
  - [ ] init;
  - [ ] snapshot;
  - [ ] new change;
  - [ ] describe;
  - [ ] bookmark move;
  - [ ] tag create;
  - [ ] policy update later;
  - [ ] workspace operations later.
- [ ] Implement `tg op log` or `tg log --ops`.
- [ ] Implement `tg undo OPERATION_ID` for local mutable view changes.
- [ ] Do not delete immutable objects during undo.

### 7.5 Acceptance gate

- [ ] Repeated snapshots of same change keep same `changeId`.
- [ ] `tg new main` creates a separate change without moving `main`.
- [ ] Bookmark move requires explicit command.
- [ ] Tag cannot be moved.
- [ ] Undo restores previous bookmark/workspace view.

## 8. Policy engine

### 8.1 Policy model

- [ ] Implement `src/policy/model.ts`.
- [ ] Define principals:
  - [ ] `public`
  - [ ] `user:<id>`
  - [ ] `group:<id>`
  - [ ] `owner`
- [ ] Define actions from `design.md`.
- [ ] Define resource selectors:
  - [ ] repo-wide;
  - [ ] exact path;
  - [ ] path glob;
  - [ ] bookmark;
  - [ ] merge request;
  - [ ] release gate.
- [ ] Define conditions:
  - [ ] visibility label;
  - [ ] release gate state;
  - [ ] time window;
  - [ ] projection.

### 8.2 Policy parser

- [ ] Decide policy file format for CLI input: JSON first, YAML optional later.
- [ ] Implement parser and validator.
- [ ] Reject unknown actions.
- [ ] Reject invalid path patterns.
- [ ] Add tests for parser failures.

### 8.3 Evaluator

- [ ] Implement `src/policy/evaluator.ts`.
- [ ] Inputs:
  - [ ] actor;
  - [ ] groups;
  - [ ] action;
  - [ ] resource;
  - [ ] context.
- [ ] Implement specificity sorting.
- [ ] Implement deny-over-allow at same specificity.
- [ ] Implement default deny.
- [ ] Return concealment decision when denied.
- [ ] Add property tests for rule ordering.

### 8.4 CLI policy commands

- [ ] Implement `tg policy show`.
- [ ] Implement `tg policy allow PRINCIPAL ACTION PATH`.
- [ ] Implement `tg policy deny PRINCIPAL ACTION PATH`.
- [ ] Implement `tg policy check PRINCIPAL ACTION PATH`.
- [ ] Implement `tg policy set-visibility PATH VISIBILITY`.
- [ ] Every policy update creates a new policy object and operation log entry.

### 8.5 Local write checks

- [ ] During `tg snapshot`, compute changed paths.
- [ ] Evaluate actor `path:write` for each changed path.
- [ ] Warn or fail locally when actor lacks write permission.
- [ ] Use `--force-local` only for offline experiments; server must still reject unauthorized push.

### 8.6 Acceptance gate

- [ ] Public can read `/src/**` only when policy allows.
- [ ] Public cannot read `.env` when policy denies.
- [ ] Maintainer can write all paths under default owner policy.
- [ ] More specific deny overrides broad allow.
- [ ] Default deny works for unknown principals.

## 9. Identity, signatures, and local key storage

### 9.1 Identity creation

- [ ] Implement `src/crypto/identity.ts`.
- [ ] `tg id create --name "Alice" --email "alice@example.com"`.
- [ ] Generate signing keypair.
- [ ] Generate encryption keypair.
- [ ] Store public identity metadata.
- [ ] Store private keys encrypted with passphrase or OS keychain adapter.
- [ ] For v0 tests, allow `TG_INSECURE_TEST_KEYS=1` to use unencrypted temp keys.

### 9.2 Signatures

- [ ] Implement `src/crypto/signatures.ts`.
- [ ] Sign canonical revision payloads.
- [ ] Sign policy objects.
- [ ] Sign bookmark moves.
- [ ] Sign tags.
- [ ] Verify signatures on read/push.
- [ ] Add tamper tests.

### 9.3 Trust store

- [ ] Implement local trusted identities table or config.
- [ ] `tg id trust <identity-file>`.
- [ ] `tg id list`.
- [ ] Policy rules can reference trusted user/group IDs.

### 9.4 Acceptance gate

- [ ] New revisions contain valid signatures.
- [ ] Tampering with signed payload fails verification.
- [ ] CLI refuses to use missing/locked private key with clear error.

## 10. Encrypted private files and key grants

### 10.1 Encryption module

- [ ] Implement `src/crypto/encryption.ts` behind an interface.
- [ ] Functions:
  - [ ] `generateDek()`
  - [ ] `encryptBlob(plaintext, aad)`
  - [ ] `decryptBlob(ciphertext, dek, aad)`
  - [ ] `wrapDekForRecipient(dek, recipientPublicKey)`
  - [ ] `unwrapDek(grant, recipientPrivateKey)`
- [ ] Add known-answer or round-trip tests.
- [ ] Test wrong AAD fails decryption.
- [ ] Test wrong recipient cannot unwrap DEK.

### 10.2 Key grants

- [ ] Implement `src/crypto/keyGrants.ts`.
- [ ] Create key grants for users.
- [ ] Create simple group grants.
- [ ] Store grants in DB and as objects when syncing.
- [ ] Implement grant revocation metadata.
- [ ] Implement group key rotation placeholder.

### 10.3 Secret tracking command

- [ ] Implement `tg secret track PATH --visible-to PRINCIPAL --conceal hide|redact|name-only`.
- [ ] Mark path as secret/private in policy.
- [ ] Create encrypted blob on next snapshot.
- [ ] Set local materialization mode to `0600` where supported.
- [ ] Implement `tg secret list`.
- [ ] Implement `tg secret untrack PATH` with warning that historical revisions remain encrypted and may remain accessible to old grantees.

### 10.4 Snapshot encryption integration

- [ ] During snapshot, detect secret/private paths from policy.
- [ ] Encrypt private paths before storing.
- [ ] Create key grants for authorized recipients.
- [ ] Ensure plaintext bytes are not stored in object envelope.
- [ ] Add tests that grep `.tg/objects` for a known secret string and fail if found.

### 10.5 Read/decrypt integration

- [ ] `SnapshotFS.readFile` checks policy.
- [ ] If blob is encrypted, find usable key grant.
- [ ] Decrypt into memory only.
- [ ] Return clear errors:
  - [ ] no read permission;
  - [ ] read allowed but no key grant;
  - [ ] corrupted ciphertext;
  - [ ] locked private key.

### 10.6 Acceptance gate

- [ ] `.env` can be tracked and snapshotted.
- [ ] `.tg/objects` does not contain `.env` plaintext.
- [ ] Authorized identity can read `.env`.
- [ ] Unauthorized identity cannot read `.env`.
- [ ] Revocation warning is displayed when removing a recipient.

## 11. Projection builder and public safety checks

### 11.1 Projection builder

- [ ] Implement `src/policy/projection.ts`.
- [ ] Function: `buildProjection(sourceRevision, audience, policy)`.
- [ ] Traverse tree and evaluate `path:read-name` / `path:read-content`.
- [ ] Implement concealment modes:
  - [ ] `hide`: omit entry.
  - [ ] `redact`: include redaction placeholder.
  - [ ] `name-only`: include placeholder with name and metadata only.
- [ ] Rebuild filtered tree objects.
- [ ] Create projection object.
- [ ] Add tests for hidden private paths.

### 11.2 Public check

- [ ] Implement `src/repo/publicCheck.ts`.
- [ ] Check hidden paths absent from public tree.
- [ ] Check private key grants unreachable.
- [ ] Check encrypted private blobs unreachable unless intentionally included as encrypted public artifacts.
- [ ] Add simple secret scanner:
  - [ ] `.env` key-value patterns;
  - [ ] common token prefixes;
  - [ ] high-entropy strings threshold.
- [ ] Make scanner configurable.

### 11.3 CLI commands

- [ ] Implement `tg projection build --audience public`.
- [ ] Implement `tg projection list`.
- [ ] Implement `tg public-check [REV]`.
- [ ] Public check must fail with non-zero exit code on leak.

### 11.4 Acceptance gate

- [ ] Public projection omits `.env` when concealment is `hide`.
- [ ] Public projection shows placeholder when concealment is `redact`.
- [ ] Public check fails when a public plaintext file contains configured secret pattern.
- [ ] Public check passes for clean public projection.

## 12. Virtual file system and workspaces

### 12.1 VFS interfaces

- [ ] Implement `src/vfs/types.ts`.
- [ ] Define `VirtualFileSystem` interface from `design.md`.
- [ ] Define `DirEntry`, `FileStat`, `WriteOptions`, `WorkspaceDiff`.
- [ ] All VFS methods must use normalized repo paths.

### 12.2 SnapshotFS

- [ ] Implement read-only `SnapshotFS`.
- [ ] Read tree entries lazily.
- [ ] Decrypt only on `readFile`.
- [ ] Enforce policy on read/list operations.
- [ ] Add tests for public vs private projection listing.

### 12.3 OverlayFS

- [ ] Implement writable overlay over `SnapshotFS`.
- [ ] Track writes, deletes, renames, mkdirs.
- [ ] `diff()` returns overlay changes.
- [ ] `snapshot()` writes new blobs/trees/revision.
- [ ] Add tests with multiple overlays from same base.

### 12.4 Materializer

- [ ] Implement `NodeMaterializedFS`.
- [ ] Materialize a projection/workspace into `.tg/tmp/materialized/<workspace-id>` or user-selected path.
- [ ] Set private file mode `0600` when supported.
- [ ] Write a materialization manifest with path hashes.
- [ ] Import modifications back into overlay by comparing hashes and mtimes.
- [ ] Never materialize hidden files for unauthorized projections.

### 12.5 Workspace commands

- [ ] Implement `tg workspace create --from REV_OR_BOOKMARK --projection NAME --owner NAME`.
- [ ] Implement `tg workspace list`.
- [ ] Implement `tg workspace status WS`.
- [ ] Implement `tg workspace materialize WS [PATH]`.
- [ ] Implement `tg workspace snapshot WS -m "message"`.
- [ ] Implement `tg workspace remove WS`.
- [ ] Optional: `tg workspace exec WS -- <command>`.

### 12.6 Acceptance gate

- [ ] Two workspaces can start from `main` simultaneously.
- [ ] Editing one workspace does not affect the other.
- [ ] Neither workspace locks or owns the `main` bookmark.
- [ ] Materialized workspace can be deleted without losing snapshotted VFS state.
- [ ] Unauthorized projection never materializes private files.

## 13. Merge engine

### 13.1 Three-way tree merge

- [ ] Implement `src/repo/merge.ts`.
- [ ] Inputs: base revision, target revision, source revision, actor, policy.
- [ ] Compute changed paths target-vs-base and source-vs-base.
- [ ] Merge non-overlapping path changes.
- [ ] Detect path conflicts.
- [ ] Detect file mode conflicts.

### 13.2 Text merge

- [ ] Add simple line-based three-way text merge.
- [ ] If unresolved, create structured conflict object.
- [ ] Materializer can render conflict markers for compatibility.

### 13.3 Policy checks

- [ ] Actor needs read access to inspect source private paths.
- [ ] Actor needs write access to target changed paths.
- [ ] Public target needs safe public projection.
- [ ] Server will repeat all checks later.

### 13.4 CLI merge

- [ ] Implement `tg merge SOURCE --into TARGET`.
- [ ] Display conflicts clearly.
- [ ] Do not move bookmark unless merge succeeds and user requested it.

### 13.5 Acceptance gate

- [ ] Non-overlapping file changes merge cleanly.
- [ ] Same-line text conflict produces conflict object.
- [ ] Unauthorized merge of private path fails.
- [ ] Public merge fails when public projection safety check fails.

## 14. Merge requests

### 14.1 MR model and storage

- [ ] Implement `src/mr/create.ts`.
- [ ] Implement `MergeRequestObject` validator.
- [ ] Store MRs in DB.
- [ ] Link MR to source change ID and source revision.
- [ ] Support visibility labels.

### 14.2 MR commands

- [ ] `tg mr create --to BOOKMARK [--private|--visibility LABEL]`.
- [ ] `tg mr list`.
- [ ] `tg mr show MR_ID`.
- [ ] `tg mr review MR_ID --approve|--request-changes -m "message"`.
- [ ] `tg mr merge MR_ID [--private] [--release-gate GATE]`.
- [ ] `tg mr close MR_ID`.

### 14.3 Review policy

- [ ] Only authorized reviewers can read private MRs.
- [ ] Approval rules are checked before merge.
- [ ] MR comments must not be visible outside MR visibility.
- [ ] Public MR list must omit private MRs entirely.

### 14.4 Acceptance gate

- [ ] Private MR is visible to creator and reviewer only.
- [ ] Unauthorized identity cannot list or show private MR.
- [ ] Approved MR can merge.
- [ ] Unapproved protected MR cannot merge.

## 15. Release gates and delayed public publication

### 15.1 Release gate model

- [ ] Implement `src/release/gate.ts`.
- [ ] Define gate states:
  - [ ] `draft`
  - [ ] `approved`
  - [ ] `preannounce`
  - [ ] `published`
  - [ ] `cancelled`
- [ ] Store release gates in DB.
- [ ] Link gate to source revision and target projection.

### 15.2 Release commands

- [ ] `tg release create --from REV --projection public --title "..."`.
- [ ] `tg release approve GATE`.
- [ ] `tg release preannounce GATE --to group:distro-maintainers`.
- [ ] `tg release schedule GATE --publish-at ISO_TIME`.
- [ ] `tg release publish GATE`.
- [ ] `tg release cancel GATE`.

### 15.3 Publish algorithm

- [ ] Verify actor has `release:publish`.
- [ ] Verify required approvals.
- [ ] Build target projection.
- [ ] Run public safety checks.
- [ ] Create signed projection object.
- [ ] Move target public bookmark or create tag transactionally.
- [ ] Mark linked private MRs as published if applicable.
- [ ] Write audit event.

### 15.4 Acceptance gate

- [ ] Private security fix can merge without moving public projection.
- [ ] Public users see no MR or change before publish.
- [ ] `tg release publish` moves public projection only after safety checks pass.
- [ ] Failed safety check blocks publish.

## 16. Remote server

### 16.1 Server skeleton

- [ ] Implement `src/server/app.ts`.
- [ ] Add health endpoint.
- [ ] Add request ID middleware.
- [ ] Add JSON schema validation.
- [ ] Add structured error responses using core error codes.

### 16.2 Authentication

- [ ] Implement challenge/verify flow.
- [ ] Client signs challenge with identity signing key.
- [ ] Server creates short-lived session token or validates signed requests.
- [ ] Add tests for invalid signatures.

### 16.3 Repo APIs

- [ ] `POST /v1/repos`.
- [ ] `GET /v1/repos/:repoId`.
- [ ] `GET /v1/repos/:repoId/view?projection=...`.
- [ ] Enforce repo-level read permission.

### 16.4 Object APIs

- [ ] `POST /objects/batch/has`.
- [ ] `POST /objects/batch/get`.
- [ ] `POST /objects/batch/put`.
- [ ] Verify object hashes on put.
- [ ] Enforce ACL before get.
- [ ] Do not leak existence of hidden objects to unauthorized users unless policy says name-only/redact.

### 16.5 Sync APIs

- [ ] Define `PushRequest` and `PullRequest` in `src/sync/protocol.ts`.
- [ ] Implement client push.
- [ ] Implement server push validation.
- [ ] Implement client pull.
- [ ] Implement server projection-aware pull.

### 16.6 Server-side validation

- [ ] Verify request signature.
- [ ] Verify object hashes.
- [ ] Validate schemas.
- [ ] Verify parent object availability.
- [ ] Recompute changed paths for each revision.
- [ ] Evaluate write permissions.
- [ ] Validate encryption for private paths.
- [ ] Reject unauthorized bookmark moves.
- [ ] Reject unauthorized policy updates.
- [ ] Apply transactionally.

### 16.7 Acceptance gate

- [ ] Authorized user can push public change.
- [ ] Unauthorized user cannot fetch private blob.
- [ ] Malicious client cannot push path it cannot write.
- [ ] Public pull returns only public projection objects.
- [ ] Server does not need private blob plaintext to store/fetch ciphertext.

## 17. Sync client commands

### 17.1 Remotes

- [ ] `tg remote add NAME URL`.
- [ ] `tg remote list`.
- [ ] `tg remote remove NAME`.

### 17.2 Push and pull

- [ ] `tg sync push [REMOTE]`.
- [ ] `tg sync pull [REMOTE] [--projection NAME]`.
- [ ] Show object counts:
  - [ ] uploaded objects;
  - [ ] skipped existing objects;
  - [ ] downloaded objects;
  - [ ] redacted objects.
- [ ] Handle partial failures safely.

### 17.3 Acceptance gate

- [ ] Local repo can push to local test server.
- [ ] Second local repo can pull from server.
- [ ] Public projection clone cannot decrypt or access private files.

## 18. Git import/export

### 18.1 Git import

- [ ] Decide implementation mechanism:
  - [ ] shell out to `git` for v0; or
  - [ ] use a JS Git library.
- [ ] `tg git import PATH_OR_URL`.
- [ ] Convert Git commits to revisions.
- [ ] Map Git branches to bookmarks.
- [ ] Map Git tags to immutable tags.
- [ ] Store original Git SHA in revision metadata.
- [ ] Default imported visibility to `public` or command-specified label.

### 18.2 Git export

- [ ] `tg git export --projection public --to PATH`.
- [ ] Build public projection first.
- [ ] Create a Git repo at target path.
- [ ] Write visible files only.
- [ ] Export commits or squash based on option:
  - [ ] `--squash` for simple public export;
  - [ ] `--history` for compatible history where safe.
- [ ] Run public check before export.

### 18.3 Acceptance gate

- [ ] Import a small Git repo with branches and tags.
- [ ] Export public projection to Git.
- [ ] Exported Git repo contains no private files.
- [ ] `git status` in exported repo is clean.

## 19. End-to-end scenarios

### 19.1 Scenario A: tracked `.env`

- [ ] Create identities Alice, Bob, Eve.
- [ ] Alice initializes repo.
- [ ] Alice creates group `maintainers` with Alice and Bob.
- [ ] Alice tracks `src/index.ts` public.
- [ ] Alice tracks `.env` private to maintainers.
- [ ] Alice snapshots and pushes.
- [ ] Bob pulls maintainer projection.
- [ ] Bob reads/materializes `.env`.
- [ ] Eve pulls public projection.
- [ ] Eve cannot see `.env` path when concealment is `hide`.
- [ ] Eve cannot fetch private blob by guessed object ID.
- [ ] Public Git export contains no `.env`.

### 19.2 Scenario B: private security fix

- [ ] Maintainer creates private change.
- [ ] Maintainer opens MR with visibility `security-embargo`.
- [ ] Public user cannot list MR.
- [ ] Security reviewer can list/show MR.
- [ ] Security reviewer approves.
- [ ] MR merges to private lane.
- [ ] Public projection remains unchanged.
- [ ] Release gate publishes after approval.
- [ ] Public projection updates only after publish.

### 19.3 Scenario C: agent workspaces

- [ ] Create three workspaces from `main`.
- [ ] Materialize each workspace.
- [ ] Modify different files in each.
- [ ] Snapshot each workspace.
- [ ] Confirm `main` bookmark did not move.
- [ ] Create private MR from each workspace.

### 19.4 Scenario D: unauthorized write rejection

- [ ] Contractor has read `/src/**` and write `/docs/**`.
- [ ] Contractor edits `/ops/prod.env`.
- [ ] Local snapshot warns/fails.
- [ ] Malicious forced snapshot can be created locally only if forced.
- [ ] Server push rejects unauthorized changed path.
- [ ] Audit log records rejection without exposing private content.

## 20. Security tests

- [ ] Grep object store for known secret after encrypted snapshot.
- [ ] Attempt to decrypt with wrong key.
- [ ] Attempt path traversal in snapshot and materializer.
- [ ] Attempt Unicode/case collision path bypass.
- [ ] Attempt public projection export with hidden secret file.
- [ ] Attempt public projection export with secret-looking plaintext.
- [ ] Attempt unauthorized object fetch.
- [ ] Attempt unauthorized bookmark move.
- [ ] Attempt unauthorized policy update.
- [ ] Attempt malicious client changed-path omission.
- [ ] Attempt tampered signed revision.
- [ ] Attempt tampered policy object.
- [ ] Attempt replayed signed bookmark move if operation nonce/versioning is implemented.

## 21. Documentation tasks

- [ ] Write README with:
  - [ ] project goal;
  - [ ] non-endorsement note;
  - [ ] installation;
  - [ ] quickstart;
  - [ ] `.env` private tracking example;
  - [ ] private MR example;
  - [ ] workspace example;
  - [ ] security limitations.
- [ ] Write `docs/model.md` for object model.
- [ ] Write `docs/policy.md` for ACL rules.
- [ ] Write `docs/crypto.md` for encryption and key grants.
- [ ] Write `docs/server.md` for remote API.
- [ ] Write `docs/git-interop.md` for import/export limitations.
- [ ] Add CLI help examples for every command.

## 22. Release checklist for prototype v0

- [ ] All unit tests pass.
- [ ] All integration tests pass.
- [ ] End-to-end scenarios A-D pass.
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm build` passes.
- [ ] README quickstart works from a clean machine.
- [ ] Public projection safety check is enabled by default for export/publish.
- [ ] Known limitations are documented:
  - [ ] revocation cannot erase already-fetched plaintext;
  - [ ] local machine compromise is out of scope;
  - [ ] v0 projection proofs are signed projections, not full redaction proofs;
  - [ ] Git compatibility is projection export/import, not native hosting.
- [ ] Package metadata and docs avoid endorsement claims.

## 23. Suggested implementation order summary

1. Project skeleton and CLI smoke test.
2. Path normalization and canonical object encoding.
3. Local CAS and SQLite metadata.
4. Repo init/open/status/snapshot.
5. Diff engine.
6. Changes, bookmarks, tags, operation log, undo.
7. Policy engine.
8. Identity/signatures.
9. Encrypted blobs and key grants.
10. Projection builder and public safety checks.
11. VFS and workspaces.
12. Merge engine.
13. Merge requests.
14. Release gates.
15. Remote server and sync.
16. Git import/export.
17. Full end-to-end hardening.

