# Design: Git that Theo Wants

Status: implementation design for a prototype

Working name: `tg` / TheoGit. The name is only a codename. Do not imply endorsement by Theo or any linked creator.

Primary implementation assumption: TypeScript/Node.js local-first CLI plus an optional HTTP sync server. The core model is intentionally language-independent, but TypeScript is the recommended prototype target because the task explicitly points at JavaScript/TypeScript-hosted runtimes and agent execution.

## 1. Problem statement

Git is excellent at immutable content-addressed history, distributed replication, and ecosystem compatibility. It is weak at concepts that modern teams increasingly need:

- path/file-level privacy and authorization;
- private work-in-progress changes that do not leak through branch names, issue trackers, pull requests, or commit hashes;
- tracked secrets such as `.env` without pushing plaintext to everyone with repository access;
- embargoed security fixes and delayed publication windows;
- a working model closer to snapshots, stable change IDs, and lightweight names than to branch-heavy workflows;
- isolated agent workspaces that do not fight over OS checkout state;
- source-control operations that can run against a virtual file system instead of repeatedly materializing huge trees on APFS or another real file system.

This design describes a new VCS prototype that keeps the useful parts of Git, rejects Git's repository-level trust model, and treats visibility, cryptography, policy, and virtualized workspaces as core primitives.

## 2. Product goals

### 2.1 Core goals

1. **Track private files safely**
   - A file such as `.env` can be versioned.
   - Unauthorized users cannot fetch its plaintext.
   - The server can store encrypted objects without being able to decrypt them.
   - Public projections of the repository can hide the file entirely or show a redacted placeholder, depending on policy.

2. **Fine-grained permissions**
   - Permissions can apply at repository, path, subtree, bookmark, change, merge-request, and release-gate level.
   - Repository access does not imply access to every object.
   - A user can have read access to `/src/**` and no access to `/ops/secrets/**`.
   - A reviewer can access a private merge request without granting general repository-wide access.

3. **Private changes and private review**
   - Work can exist as private changes, private bookmarks, or private merge requests.
   - Merge requests can be invisible to the public until a publish event.
   - Security fixes can be merged into a private release lane and published later.

4. **Open-source projections**
   - One repository can have multiple audience views: public, maintainers, contractors, security team, distro maintainers, internal-only, etc.
   - The public view can be genuinely open source while internal-only files remain private.
   - The same source graph can produce different projections without forcing multiple Git repositories.

5. **Snapshot-first workflow**
   - The user edits a working copy. The system snapshots state automatically before operations or explicitly through `tg snapshot`.
   - A stable `changeId` survives amendments and rebases.
   - Immutable `revisionId`s identify concrete snapshots.
   - Mutable bookmarks replace most branch usage.
   - Immutable tags mark releases.

6. **Agent-safe workspaces**
   - Multiple agents can derive isolated views from the same snapshot or bookmark.
   - No branch can be "hijacked" by another worktree.
   - Workspaces are overlays in a virtual file system; materialization to disk is optional and scoped.

7. **File-system independence**
   - Core repository operations run against an abstract virtual file system.
   - Tools that require real files can receive a temporary materialized view.
   - The system minimizes small-file churn by lazily materializing only what a process needs.

8. **Useful migration path**
   - The prototype can import from Git.
   - The prototype can export public projections to Git for compatibility.
   - GitHub/GitLab compatibility is a bridge, not the core model.

### 2.2 Non-goals for the first prototype

- Full Git smart-protocol compatibility.
- Perfect hidden-path cryptographic proofs for every projection in v0.
- Transparent kernel-level FUSE implementation. The first version should use a TypeScript virtual file system and optional materialization.
- Solving local machine compromise. If an attacker owns a developer laptop while secrets are decrypted, the VCS cannot fully protect them.
- Revoking access to ciphertext that was already fetched and decrypted by a user. Revocation means future access is blocked and future snapshots use new keys.
- Replacing dedicated runtime secrets managers in production immediately. The prototype proves that versioned encrypted config is possible and ergonomic.

## 3. Key concepts and terminology

### Repository

A logical project containing objects, policies, identities, changes, bookmarks, tags, merge requests, and release gates. A repository can have many visibility projections.

### Object

An immutable content-addressed record. Examples: blob, tree, revision, policy, key grant, merge request, operation log entry.

### Blob

File contents. A blob can be public plaintext, encrypted private content, or compressed plaintext for local/private use.

### Tree

Directory-like mapping from path segment to child object references. Tree entries can attach metadata, file mode, and policy references.

### Revision

An immutable snapshot of the repository state. A revision points to a root tree, parent revisions, policy snapshot, author metadata, and signatures. This is the nearest analogue to a Git commit, but the UI should avoid making users think in commits.

### Change

A logical unit of work with a stable `changeId`. A change can have many revisions as it is amended, rebased, split, or merged. Review discussion should attach to `changeId` and path ranges, not unstable revision hashes.

### Bookmark

A mutable name pointing to a revision. Bookmarks are the replacement for most branch usage. A bookmark can be public or private. Moving a bookmark is a policy-controlled operation.

### Tag

An immutable, signed name for a release revision or projection revision. Tags are intended for releases, checkpoints, and external distribution.

### Projection

A filtered and possibly redacted view of a repository for a specific audience. Examples: `public`, `maintainers`, `security-embargo`, `distro-maintainers`, `alice-private`.

### Policy

A signed, versioned rule set controlling who can read, write, review, merge, publish, administer, and decrypt specific repository resources.

### Workspace

An isolated editable view of a base revision. A workspace is an overlay over a snapshot and may be in-memory, persisted in the local store, or materialized to a directory for external tools.

### Operation log

A local append-only log of user-visible operations: snapshot, new change, amend, rebase, bookmark move, merge, policy update, undo, materialize, sync. It enables safe undo and auditability.

## 4. High-level architecture

```text
+-----------------------------+
| CLI / SDK / Agent API       |
| tg init/status/snapshot/... |
+--------------+--------------+
               |
+--------------v--------------+
| Application Services        |
| repo, changes, merge, ACL,  |
| MR, release, sync, workspace|
+--------------+--------------+
               |
+--------------v--------------+
| Core Model                  |
| objects, revisions, trees,  |
| policies, identities, ops   |
+-------+---------+-----------+
        |         |
+-------v--+   +--v-----------+
| Storage  |   | Crypto       |
| CAS + DB |   | keys, grants |
+-------+--+   +--+-----------+
        |         |
+-------v---------v-----------+
| VFS / Materialization       |
| in-memory, overlay, disk    |
+--------------+--------------+
               |
+--------------v--------------+
| Optional Remote Server      |
| auth, ACL enforcement, sync,|
| projection serving, MR API  |
+-----------------------------+
```

### 4.1 Local-first core

The local repository must be useful without a server:

- initialize repo;
- snapshot files;
- create changes;
- diff revisions;
- manage bookmarks and tags;
- encrypt/decrypt private files for local identities;
- evaluate policies;
- create isolated workspaces;
- import/export public Git snapshots.

The server adds multi-user auth, object exchange, remote policy enforcement, merge requests, release gates, and team key distribution.

### 4.2 Recommended implementation stack

- Language: TypeScript 5.x.
- Runtime: Node.js 22+ or current active LTS when implemented.
- Package manager: `pnpm`.
- CLI framework: `commander` or `clipanion`.
- Local DB: SQLite through a small repository wrapper. Prefer `better-sqlite3` for initial simplicity unless native dependencies are unacceptable.
- Object encoding: canonical JSON for v0, with an internal interface that can later switch to canonical CBOR.
- Compression: Brotli or zstd wrapper. Start with Node Brotli to reduce dependencies.
- Crypto: libsodium-compatible primitives through `libsodium-wrappers-sumo` for X25519/Ed25519/XChaCha20-Poly1305-style envelope encryption, or an equivalent audited library. Hide crypto behind interfaces so it can be swapped.
- Server: Fastify or Hono. Keep server API transport-independent.
- Tests: Vitest for unit/integration tests; property tests for path normalization and policy evaluation.

## 5. Repository layout

A local repository has a `.tg` directory at its root unless it is an in-memory/agent-only repository.

```text
.tg/
  repo.json                 # repo id, format version, local config pointer
  config.json               # local-only config, remotes, current identity, defaults
  db.sqlite                 # metadata index, refs, policy cache, op log
  objects/
    sha256/
      aa/
        <object-id>.obj     # immutable object envelopes
  keys/
    identity.json           # public identity metadata
    device.enc              # encrypted local private keys; never sync plaintext
  workspaces/
    <workspace-id>.json     # overlay roots, materialization state
  tmp/
    materialized/           # temp directories for external tools
    downloads/              # object fetch staging
```

### 5.1 `repo.json`

```json
{
  "format": "tg.repo.v1",
  "repoId": "repo_01j...",
  "createdAt": "2026-06-28T00:00:00.000Z",
  "defaultVisibility": "private",
  "objectHash": "sha256",
  "canonicalEncoding": "json-jcs-v1"
}
```

### 5.2 Object envelope

Every object stored in `objects/` uses a small envelope:

```ts
type ObjectEnvelope = {
  magic: "TGOBJ";
  format: 1;
  objectId: ObjectId;
  objectType: ObjectType;
  hashAlgorithm: "sha256";
  encoding: "json-jcs-v1" | "raw";
  compression: "none" | "brotli";
  encryption: "none" | "sealed-dek-v1";
  payloadBytes: Uint8Array;
};
```

For public plaintext objects, `objectId = sha256(canonicalPayloadBytes)`.

For encrypted objects, `objectId = sha256(canonicalEncryptedEnvelopePayload)`, not `sha256(plaintext)`. This avoids leaking whether an attacker guessed a small secret file. Authorized clients can store an encrypted plaintext digest inside encrypted metadata if they need deduplication or integrity checks after decryption.

## 6. Object model

### 6.1 Shared ID rules

Use opaque, typed IDs in user-facing and DB-facing APIs:

```ts
type ObjectId = `obj_${string}`;
type RevisionId = `rev_${string}`;
type ChangeId = `chg_${string}`;
type PolicyId = `pol_${string}`;
type UserId = `usr_${string}`;
type GroupId = `grp_${string}`;
type BookmarkName = string;
type WorkspaceId = `ws_${string}`;
```

IDs should be stable, URL-safe, and not reveal path names, branch names, or secret contents.

### 6.2 Blob object

```ts
type BlobObject = {
  type: "blob";
  format: 1;
  byteLength: number;
  executable: boolean;
  mediaType?: string;
  content: {
    storage: "inline" | "external-cas";
    bytes?: string;       // base64 for tiny inline blobs only
    objectId?: ObjectId;  // for raw content chunks
  };
  encryption: EncryptionDescriptor;
  privateMetadata?: EncryptedMetadataRef;
};
```

Large files can be chunked later. The v0 implementation can store whole-file blobs and define a chunking interface for future replacement.

### 6.3 Tree object

```ts
type TreeObject = {
  type: "tree";
  format: 1;
  entries: TreeEntry[];
};

type TreeEntry = {
  name: string | EncryptedName;
  kind: "file" | "directory" | "symlink" | "conflict";
  objectId: ObjectId;
  mode: "file" | "executable" | "symlink";
  policyRef?: PolicyId;
  visibility: VisibilityLabel;
  metadata?: Record<string, unknown>;
};
```

Rules:

- Entry names are normalized before storage.
- No `.` or `..` segments.
- Always use `/` as the separator in canonical paths.
- Reject paths that differ only by Unicode normalization form.
- Reject ambiguous case-colliding paths by default for cross-platform safety. Allow opt-in case-sensitive repos later.

### 6.4 Revision object

```ts
type RevisionObject = {
  type: "revision";
  format: 1;
  revisionId: RevisionId;
  changeId: ChangeId;
  parents: RevisionId[];
  rootTree: ObjectId;
  policySnapshot: PolicyId;
  projections: ProjectionRef[];
  author: IdentityRef;
  committer?: IdentityRef;
  createdAt: string;
  message: string;
  visibility: VisibilityLabel;
  signatures: Signature[];
};
```

`revisionId` is derived from the canonical payload excluding signatures that are added after the object is prepared. Signatures cover the unsigned canonical payload.

### 6.5 Change object

```ts
type ChangeObject = {
  type: "change";
  format: 1;
  changeId: ChangeId;
  title: string;
  description?: string;
  currentRevision: RevisionId;
  revisions: RevisionId[];
  state: "open" | "merged" | "abandoned";
  visibility: VisibilityLabel;
  createdBy: UserId;
  createdAt: string;
  updatedAt: string;
};
```

A change is mutable metadata pointing at immutable revisions. It should be stored in the DB and optionally mirrored as signed metadata objects for sync.

### 6.6 Bookmark object

```ts
type BookmarkObject = {
  type: "bookmark";
  format: 1;
  name: string;
  target: RevisionId;
  scope: "repo" | "user" | "group" | "workspace";
  owner?: UserId | GroupId;
  visibility: VisibilityLabel;
  updatedBy: UserId;
  updatedAt: string;
  signatures: Signature[];
};
```

Bookmarks are mutable named pointers. They are not branches. A bookmark can point to any revision, and creating a new change does not implicitly move a bookmark unless a command explicitly says so.

### 6.7 Tag object

```ts
type TagObject = {
  type: "tag";
  format: 1;
  name: string;
  target: RevisionId | ProjectionRevisionId;
  immutable: true;
  releaseChannel?: string;
  createdBy: UserId;
  createdAt: string;
  signatures: Signature[];
};
```

Tags cannot be moved. If a release must be corrected, create a new tag such as `v1.2.1` or a signed revocation object.

### 6.8 Policy object

```ts
type PolicyObject = {
  type: "policy";
  format: 1;
  policyId: PolicyId;
  parentPolicy?: PolicyId;
  rules: PolicyRule[];
  createdBy: UserId;
  createdAt: string;
  signatures: Signature[];
};

type PolicyRule = {
  effect: "allow" | "deny";
  principal: PrincipalSelector;
  actions: Action[];
  resource: ResourceSelector;
  condition?: PolicyCondition;
  concealment?: "hide" | "redact" | "name-only";
};
```

### 6.9 Key grant object

```ts
type KeyGrantObject = {
  type: "keyGrant";
  format: 1;
  grantId: string;
  subjectObject: ObjectId | PathPattern | PolicyId;
  recipientKeyId: string;
  encryptedDek: string;
  algorithm: "sealed-dek-v1";
  createdBy: UserId;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
};
```

Key grants are how an encrypted object's data encryption key reaches authorized users.

### 6.10 Merge request object

```ts
type MergeRequestObject = {
  type: "mergeRequest";
  format: 1;
  mrId: string;
  title: string;
  description?: string;
  sourceChangeIds: ChangeId[];
  sourceRevision: RevisionId;
  targetBookmark: string;
  targetRevisionAtOpen: RevisionId;
  visibility: VisibilityLabel;
  reviewers: PrincipalSelector[];
  requiredApprovals: ApprovalRule[];
  releaseGate?: ReleaseGateId;
  state: "open" | "approved" | "merged-private" | "published" | "closed";
  createdBy: UserId;
  createdAt: string;
  updatedAt: string;
};
```

### 6.11 Operation object

```ts
type OperationObject = {
  type: "operation";
  format: 1;
  operationId: string;
  actor: UserId;
  command: string;
  beforeView: ViewState;
  afterView: ViewState;
  createdAt: string;
  inputs: ObjectId[];
  outputs: ObjectId[];
};
```

The operation log is primarily local but can be optionally synchronized for audit in enterprise mode.

## 7. Permissions and visibility

### 7.1 Visibility labels

Start with four built-in visibility labels:

- `public`: visible to unauthenticated users or public mirror consumers.
- `internal`: visible to authenticated repository members.
- `restricted`: visible to named groups/users.
- `private`: visible only to owner and explicitly granted users.

Allow repositories to define custom labels later, for example `security-embargo`, `distro`, `contractor`, `customer-a`.

### 7.2 Action model

Use explicit actions instead of broad roles:

```ts
type Action =
  | "repo:read"
  | "repo:admin"
  | "path:read-name"
  | "path:read-content"
  | "path:write"
  | "path:delete"
  | "revision:create"
  | "change:read"
  | "change:update"
  | "bookmark:read"
  | "bookmark:move"
  | "mr:create"
  | "mr:read"
  | "mr:review"
  | "mr:merge"
  | "release:create"
  | "release:publish"
  | "policy:read"
  | "policy:update"
  | "keygrant:create"
  | "keygrant:revoke";
```

### 7.3 Policy evaluation

Evaluation algorithm:

1. Normalize actor identity and group membership.
2. Normalize resource path or object target.
3. Gather candidate rules from repository policy, inherited subtree policies, entry-level policy refs, and merge request/release policy.
4. Filter candidate rules by action and resource selector.
5. Apply conditions such as time window, release state, source revision, or reviewer status.
6. Sort by specificity:
   - exact path rule;
   - deeper subtree rule;
   - path glob rule;
   - resource type rule;
   - repository-wide rule.
7. `deny` wins over `allow` at the same specificity.
8. Default is deny.
9. Return `allow`, `deny`, or `redacted` with a concealment mode.

### 7.4 Path rule examples

```yaml
rules:
  - effect: allow
    principal: public
    actions: [path:read-name, path:read-content]
    resource: path:/src/**

  - effect: deny
    principal: public
    actions: [path:read-name, path:read-content]
    resource: path:/.env
    concealment: hide

  - effect: allow
    principal: group:maintainers
    actions: [path:read-name, path:read-content, path:write]
    resource: path:/**

  - effect: allow
    principal: group:security
    actions: [path:read-name, path:read-content, path:write]
    resource: path:/security/**
    condition:
      visibility: security-embargo

  - effect: allow
    principal: group:distro-maintainers
    actions: [path:read-name, path:read-content]
    resource: path:/security/fixes/**
    condition:
      releaseGateState: preannounce
```

### 7.5 Concealment modes

- `hide`: unauthorized projections omit the path entirely.
- `redact`: unauthorized projections show a placeholder entry such as `.env [restricted]`.
- `name-only`: unauthorized projections reveal the path and metadata but not content.

Default for secrets is `hide`.
Default for internal implementation files is `redact`.
Default for private review changes is `hide`.

## 8. Encryption and key management

### 8.1 Threat model

In scope:

- Users with repository access but without specific path permissions.
- Public mirror readers.
- Honest-but-curious sync server operators.
- Accidental publication through public projections.
- Agents working in isolated workspaces.

Out of scope for v0:

- Compromised developer machine after decryption.
- Malicious dependency reading a materialized `.env` during a build.
- Covert channels through file sizes, timing, or release metadata.
- A previously authorized user retaining plaintext they already accessed.

### 8.2 Identity keys

Each identity has:

- signing key: Ed25519-like signature key for revisions, policies, bookmarks, tags, and MRs;
- encryption key: X25519-like public key for receiving wrapped data encryption keys;
- device key metadata: multiple devices per user, each with revocation state.

### 8.3 Object encryption

For each encrypted blob:

1. Generate a random 256-bit data encryption key (`DEK`).
2. Encrypt the plaintext with an AEAD algorithm.
3. Use associated data containing repo id, object type, policy id, normalized path, and format version.
4. Store ciphertext in the object envelope.
5. For each authorized recipient or group key, create a key grant wrapping the DEK.
6. Store encrypted metadata such as plaintext hash, original size, MIME hints, and secret classification.

### 8.4 Group keys

For v0, support direct grants to users and simple group grants:

- A group has a group encryption key.
- Authorized members receive a wrapped copy of the group private key or group DEK.
- When a user is removed, rotate the group key for future snapshots.
- Existing encrypted objects remain decryptable to users who already held the old key. Mark this clearly in CLI output.

### 8.5 Secret tracking workflow

```bash
tg secret track .env --visible-to group:maintainers --conceal hide
tg snapshot -m "Track local env for maintainers"
tg push
```

Expected behavior:

- The local `.env` is read and encrypted before object storage.
- The plaintext is not written to `.tg/objects`.
- Unauthorized `tg clone --projection public` does not receive the `.env` blob or its key grant.
- Authorized maintainers can materialize `.env` with file mode `0600`.
- `tg public-check` fails if a public projection contains plaintext matching configured secret patterns.

### 8.6 Redaction and public projection safety

Before publishing any revision to `public`, run:

- policy projection builder;
- object reachability check from the public projection root;
- secret scanner over public plaintext blobs;
- key grant scanner to ensure no private key grants are reachable;
- path scanner to ensure `hide` paths are absent.

## 9. Projection model

### 9.1 Why projections are needed

If one canonical Merkle tree includes private path names and object IDs, public users may learn that private files exist. If a public user cannot verify the canonical root, they cannot verify repository integrity in the usual Git-like way. Projections make this explicit.

A projection is an audience-specific tree root derived from a canonical revision under policy. Users verify the projection they are authorized to see, not necessarily the entire private canonical tree.

### 9.2 Projection object

```ts
type ProjectionObject = {
  type: "projection";
  format: 1;
  projectionId: string;
  sourceRevision: RevisionId;
  audience: VisibilityLabel | PrincipalSelector;
  rootTree: ObjectId;
  policySnapshot: PolicyId;
  redactions: RedactionSummary[];
  createdAt: string;
  signatures: Signature[];
};

type RedactionSummary = {
  mode: "none" | "count-only" | "name-only";
  count?: number;
  paths?: string[];
};
```

For v0, implement two projections:

- `private`: full view for the owner/maintainers.
- `public`: filtered view for public export.

Add arbitrary named projections after the local and server models are stable.

### 9.3 Projection construction

Input:

- source revision;
- actor/audience principal;
- policy snapshot;
- optional release gate.

Algorithm:

1. Traverse the source tree.
2. For each entry, evaluate `path:read-name`.
3. If denied with `hide`, omit entry and subtree.
4. If denied with `redact`, include a redaction placeholder object.
5. If name allowed but content denied, include a name-only placeholder.
6. If content allowed, include the child object reference.
7. Rebuild parent tree objects with filtered entries.
8. Produce a signed projection object.

### 9.4 Projection integrity

MVP integrity guarantee:

- Authorized users verify the projection object signature and the content-addressed tree reachable from that projection.
- Maintainers can verify that the projection was derived from a private canonical revision.

Future stronger guarantee:

- Publish non-interactive redaction proofs proving that omitted entries were authorized omissions under a signed policy without revealing hidden path names.

## 10. Snapshot and change workflow

### 10.1 Working copy model

There is always a current workspace with a working change `@`.

Operations follow this pattern:

1. Snapshot the current workspace if it is dirty and the command needs a consistent view.
2. Run the requested operation against immutable snapshots and in-memory objects.
3. Record an operation log entry.
4. Update workspace view to the new revision.

### 10.2 Commands

```bash
tg init
tg status
tg snapshot -m "message"
tg new [REV]
tg describe -m "message"
tg diff [A] [B]
tg log
tg undo [OPERATION]
tg bookmark create main REV
tg bookmark move main REV
tg tag create v1.0.0 REV
tg mr create --to main --private
tg mr merge MR --visibility private
tg release publish GATE
```

### 10.3 Change/revision lifecycle

```text
new change
  -> revision r1 from snapshot
  -> amend creates revision r2, same changeId
  -> rebase creates revision r3, same changeId
  -> MR reviews changeId, comments map across revisions
  -> merge creates merge revision r4 or fast-forwards target bookmark
  -> change state becomes merged
```

### 10.4 Stable review anchors

Review comments should anchor to:

- `changeId`;
- file path in a projection;
- old/new revision range;
- line range with fuzzy relocation metadata.

This prevents losing discussion when revisions are amended.

## 11. Diff and merge

### 11.1 Diff model

`diff(A, B, projection?)` compares two tree roots after applying the chosen projection.

Output:

```ts
type DiffResult = {
  from: RevisionId;
  to: RevisionId;
  projection?: string;
  files: FileDiff[];
  summary: {
    added: number;
    modified: number;
    deleted: number;
    renamed: number;
    restricted: number;
  };
};
```

Unauthorized file changes must show as `restricted` or be hidden according to policy.

### 11.2 Merge model

Start with a three-way tree merge:

- base revision;
- target revision;
- source revision.

Rules:

- If only one side changed a path, take that side if policy allows.
- If both sides changed a binary file differently, create a conflict object.
- If both sides changed text, run a line merge and create a conflict object when unresolved.
- If a path is private, only actors with read access can inspect conflict contents.
- A merge cannot move a public bookmark to a revision that contains private-only content in its public projection unless a valid public projection exists.

### 11.3 Conflict object

```ts
type ConflictObject = {
  type: "conflict";
  format: 1;
  path: string;
  base?: ObjectId;
  ours?: ObjectId;
  theirs?: ObjectId;
  mergeAlgorithm: "text-3way-v1" | "binary-v1";
  visibility: VisibilityLabel;
};
```

The materializer can render conflicts as conflict markers for tools that expect files, but the VCS should retain structured conflict objects internally.

## 12. Workspaces and virtual file system

### 12.1 VFS interface

```ts
interface VirtualFileSystem {
  readFile(path: RepoPath): Promise<Uint8Array>;
  writeFile(path: RepoPath, bytes: Uint8Array, opts?: WriteOptions): Promise<void>;
  remove(path: RepoPath): Promise<void>;
  rename(from: RepoPath, to: RepoPath): Promise<void>;
  mkdir(path: RepoPath): Promise<void>;
  listDir(path: RepoPath): Promise<DirEntry[]>;
  stat(path: RepoPath): Promise<FileStat>;
  diff(base?: RevisionId): Promise<WorkspaceDiff>;
  snapshot(message: string): Promise<RevisionId>;
}
```

### 12.2 VFS implementations

1. `SnapshotFS`
   - Read-only view over a revision/projection.
   - Lazily loads blobs from CAS.
   - Decrypts only when caller has permission and a key.

2. `OverlayFS`
   - Writable overlay over `SnapshotFS`.
   - Stores changed files as in-memory or local CAS objects.
   - Used by agent runtimes.

3. `NodeMaterializedFS`
   - Writes a selected projection to a real directory.
   - Tracks mtimes/hashes to import modifications back into overlay.
   - Should not require branch checkout state.

4. `SparseMaterializedFS`
   - Materializes only selected paths.
   - Returns placeholders for unmaterialized files.
   - Useful for agents and package-manager-heavy repos.

### 12.3 Workspace object

```ts
type Workspace = {
  workspaceId: WorkspaceId;
  baseRevision: RevisionId;
  projection: string;
  owner: UserId | "agent";
  overlayRoot: ObjectId;
  materializedPath?: string;
  locked: false;
  createdAt: string;
  updatedAt: string;
};
```

No workspace owns a bookmark. A workspace can start from `main`, but it does not check out `main` in a way that blocks other workspaces.

### 12.4 Agent runtime flow

```bash
tg workspace create --from main --projection internal --owner agent:codex-17
tg workspace exec ws_123 -- pnpm test
tg workspace snapshot ws_123 -m "Agent fix: handle policy redaction"
tg mr create --from ws_123 --to main --private
```

Expected behavior:

- Multiple agents can start from `main` simultaneously.
- Each agent gets an overlay.
- External commands see a materialized directory only when necessary.
- The materialized directory can be destroyed without losing the workspace snapshot.

## 13. Remote server and sync protocol

### 13.1 Server responsibilities

- Authenticate identities and devices.
- Store immutable objects.
- Store mutable metadata: bookmarks, changes, merge requests, releases, policies.
- Enforce ACLs before serving objects or metadata.
- Validate push operations against policy.
- Build and serve projections.
- Manage release gates and scheduled publications.
- Audit sensitive operations.

### 13.2 Server non-responsibilities

- Decrypt private blobs unless explicitly configured as a trusted server.
- Resolve local workspace conflicts.
- Guarantee revocation for data already downloaded.

### 13.3 API shape

Use HTTP+JSON for v0. Keep payloads canonical and versioned.

```http
POST /v1/auth/challenge
POST /v1/auth/verify
GET  /v1/repos/:repoId
POST /v1/repos
GET  /v1/repos/:repoId/view?projection=public
POST /v1/repos/:repoId/objects/batch/has
POST /v1/repos/:repoId/objects/batch/get
POST /v1/repos/:repoId/objects/batch/put
POST /v1/repos/:repoId/sync/push
POST /v1/repos/:repoId/sync/pull
GET  /v1/repos/:repoId/bookmarks
POST /v1/repos/:repoId/bookmarks/:name/move
POST /v1/repos/:repoId/mrs
GET  /v1/repos/:repoId/mrs/:mrId
POST /v1/repos/:repoId/mrs/:mrId/review
POST /v1/repos/:repoId/mrs/:mrId/merge
POST /v1/repos/:repoId/releases
POST /v1/repos/:repoId/releases/:releaseGateId/publish
```

### 13.4 Push validation

A push request includes:

- actor identity;
- signed operation metadata;
- new objects;
- bookmark moves;
- policy updates;
- key grants;
- merge request updates.

Server validation:

1. Verify identity and request signature.
2. Verify all object hashes.
3. Verify object schemas and format versions.
4. Verify referenced parent objects exist or are included.
5. For each new revision, compute changed paths against parents.
6. Evaluate actor permissions for each changed path.
7. Check encryption requirements for private paths.
8. Reject plaintext secret-classified paths unless policy explicitly allows.
9. Validate key grants match authorized recipients.
10. Apply bookmark/MR/release mutations transactionally.
11. Write audit entries.

### 13.5 Pull protocol

A pull request specifies:

- desired projection;
- known object IDs;
- desired bookmarks/tags/MRs;
- optional change IDs;
- maximum visibility label.

Server returns:

- metadata visible to actor;
- missing object envelopes actor can access;
- key grants actor can access;
- redacted placeholders where policy says `redact` or `name-only`.

### 13.6 Public mirror mode

Public mirrors receive only the `public` projection:

- public projection objects;
- public tags;
- public bookmarks;
- public merge requests;
- no private changes;
- no private key grants;
- no hidden path names.

## 14. Merge requests and delayed release

### 14.1 Private merge request

A private merge request is visible only to its creator, reviewers, and authorized maintainers.

Example:

```bash
tg mr create --to main --visibility security-embargo --reviewers group:security
tg mr merge MR-42 --mode private --release-gate CVE-2026-1234
tg release schedule CVE-2026-1234 --publish-at 2026-07-14T17:00:00Z --audience public
```

The public projection must not reveal:

- MR title;
- MR existence;
- source change IDs;
- patch contents;
- target bookmark movement if the target remains public.

### 14.2 Private merge semantics

Private merge means the target private lane advances, but public bookmarks/tags do not expose the change until publication.

Recommended structure:

- `main@private`: maintainer-visible bookmark.
- `main@public`: public projection bookmark.
- `security/<id>@embargo`: security-team bookmark.
- release gate links private revision to future public projection.

### 14.3 Release gate

```ts
type ReleaseGate = {
  releaseGateId: string;
  title: string;
  sourceRevision: RevisionId;
  targetProjection: string;
  publishAt?: string;
  requiredApprovals: ApprovalRule[];
  preannounceAudience?: PrincipalSelector[];
  state: "draft" | "approved" | "preannounce" | "published" | "cancelled";
  auditLog: AuditEvent[];
};
```

Publication algorithm:

1. Verify gate is approved.
2. Verify actor or scheduler has `release:publish`.
3. Rebuild target projection from source revision and policy.
4. Run public projection safety checks.
5. Create signed public projection object.
6. Move public bookmark or create public tag transactionally.
7. Mark MR and release gate as published.
8. Write audit event.

## 15. CLI design

### 15.1 Command groups

```text
tg init                         Initialize repository
tg id create                    Create local identity
tg id trust                     Trust another identity
tg status                       Show workspace state
tg snapshot                     Record workspace snapshot
tg new                          Start a new change from revision/bookmark
tg describe                     Update change title/message
tg log                          Show changes/revisions
tg diff                         Compare revisions/projections
tg undo                         Undo an operation
tg bookmark                     Manage mutable names
tg tag                          Manage immutable release names
tg policy                       Manage ACL rules
tg secret                       Track encrypted files
tg workspace                    Manage isolated workspaces
tg mr                           Manage merge requests
tg release                      Manage delayed publication
tg sync                         Pull/push remote state
tg git                          Import/export Git-compatible projections
```

### 15.2 Example status output

```text
Workspace: ws_local
Base: main@private rev_x7p...
Change: chg_k92... "Add policy redaction"
Projection: maintainers

Modified:
  src/policy/evaluator.ts
  src/server/projections.ts

Private tracked:
  .env                  encrypted, visible to group:maintainers

Restricted in this projection:
  ops/prod.env          hidden
```

### 15.3 Example public check

```text
$ tg public-check
Projection: public
Source revision: rev_abc...

OK  hidden paths absent: 12
OK  no private key grants reachable
OK  no encrypted private blobs reachable
OK  no high-confidence plaintext secrets detected
OK  public projection root: obj_123...
```

## 16. Local database schema

Use migrations. Keep schema boring.

```sql
CREATE TABLE objects (
  object_id TEXT PRIMARY KEY,
  object_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  encrypted INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  present INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE revisions (
  revision_id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL,
  root_tree TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  parents_json TEXT NOT NULL,
  author_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  message TEXT NOT NULL,
  visibility TEXT NOT NULL
);

CREATE TABLE changes (
  change_id TEXT PRIMARY KEY,
  current_revision TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  state TEXT NOT NULL,
  visibility TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE bookmarks (
  scope TEXT NOT NULL,
  owner TEXT,
  name TEXT NOT NULL,
  target_revision TEXT NOT NULL,
  visibility TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(scope, owner, name)
);

CREATE TABLE policies (
  policy_id TEXT PRIMARY KEY,
  object_id TEXT NOT NULL,
  compiled_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE key_grants (
  grant_id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  recipient_key_id TEXT NOT NULL,
  encrypted_dek TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE operations (
  operation_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  command TEXT NOT NULL,
  before_view_json TEXT NOT NULL,
  after_view_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE workspaces (
  workspace_id TEXT PRIMARY KEY,
  base_revision TEXT NOT NULL,
  projection TEXT NOT NULL,
  owner TEXT NOT NULL,
  overlay_root TEXT NOT NULL,
  materialized_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

## 17. Implementation modules

Recommended source tree:

```text
src/
  cli/
    index.ts
    commands/
  core/
    ids.ts
    result.ts
    errors.ts
    canonical.ts
    objects.ts
    schemas.ts
  storage/
    objectStore.ts
    fileObjectStore.ts
    sqlite.ts
    migrations/
  crypto/
    identity.ts
    signatures.ts
    encryption.ts
    keyGrants.ts
  policy/
    model.ts
    path.ts
    evaluator.ts
    projection.ts
  repo/
    init.ts
    open.ts
    snapshot.ts
    diff.ts
    merge.ts
    log.ts
    undo.ts
  vfs/
    types.ts
    snapshotFs.ts
    overlayFs.ts
    nodeMaterializer.ts
  workspace/
    create.ts
    exec.ts
    snapshot.ts
  sync/
    protocol.ts
    client.ts
    push.ts
    pull.ts
  server/
    app.ts
    auth.ts
    routes/
    validators/
  mr/
    create.ts
    review.ts
    merge.ts
  release/
    gate.ts
    publish.ts
  git/
    import.ts
    export.ts
  tests/
```

### 17.1 Important abstraction boundaries

- `core/` must not import `cli/`, `server/`, or Node filesystem APIs.
- `policy/` must not decrypt blobs. It evaluates metadata and actions only.
- `crypto/` must not know about CLI prompts.
- `vfs/` must depend on repository interfaces, not concrete SQLite/file stores.
- `server/` must validate through the same policy and object modules as the CLI.
- `git/` import/export must be optional and isolated.

## 18. Error model

Use typed errors with actionable messages.

Examples:

- `ERR_POLICY_DENIED`: actor lacks action on resource.
- `ERR_SECRET_PLAINTEXT_PUBLIC`: path classified as secret but requested projection is public.
- `ERR_KEY_GRANT_MISSING`: actor can read encrypted object metadata but lacks decrypt grant.
- `ERR_OBJECT_HASH_MISMATCH`: object envelope hash verification failed.
- `ERR_PATH_NOT_CANONICAL`: path normalization rejected ambiguous path.
- `ERR_PROJECTION_UNSAFE`: publish check failed.
- `ERR_REVOCATION_LIMIT`: user was revoked, but already-distributed historical objects cannot be undecrypted.

## 19. Performance design

### 19.1 Avoid small-file churn

- Snapshot by hashing file contents and tree metadata, not copying whole directories repeatedly.
- Maintain a file-state cache keyed by path, size, mtime, inode where available, and content hash.
- In VFS mode, track writes directly and skip filesystem scans.
- Materialize sparsely for tools.
- Use content-addressed blobs so unchanged files are reused.

### 19.2 Lazy loading

- Tree entries load before blobs.
- Blob content loads only on `readFile`, diff, materialize, or external command execution.
- Encrypted blobs decrypt only when read.
- Remote pull can fetch metadata first and blob content later.

### 19.3 Agent runtime strategy

For agents:

- create overlay workspace from snapshot;
- materialize only package manifests and source files needed for the task;
- optionally mount dependency directories from a shared cache;
- snapshot overlay after each agent step;
- garbage-collect abandoned overlays.

## 20. Security requirements

1. Never store plaintext private blob content in `.tg/objects`.
2. Never include private key material in pushed objects.
3. Require signed policy updates.
4. Require signed bookmark moves for protected bookmarks.
5. Require server-side validation of changed paths on push.
6. Do not trust client-provided changed-path lists; recompute them.
7. Reject path traversal and ambiguous path names.
8. Deny by default when policy evaluation is inconclusive.
9. Treat public projection generation as a security boundary.
10. Run secret scanning before public publish/export.
11. Make revocation limitations explicit in CLI output.
12. Log policy updates, release publishes, key grant changes, and protected bookmark moves.

## 21. Git interoperability

### 21.1 Import

`tg git import <path-or-url>` should:

- read Git commits;
- convert each commit to a revision;
- use Git commit SHA as imported metadata;
- create change IDs deterministically or one change per commit;
- map branches to bookmarks;
- map tags to immutable tags;
- initially mark all imported paths as `public` or `internal` based on command flag.

### 21.2 Export

`tg git export --projection public --to <path>` should:

- build the chosen projection;
- write a Git repo containing only visible files and history;
- omit private metadata, private MRs, private bookmarks, and key grants;
- optionally squash or linearize history if projection history would leak timing or private structure.

## 22. MVP scope

Build v0 in this order:

1. Local repository with object store, canonical encoding, revisions, trees, blobs.
2. Snapshot and diff from a real directory.
3. Stable changes and bookmarks.
4. Operation log and undo.
5. Policy engine with path-level read/write decisions.
6. Encrypted private blobs and key grants for local identities.
7. Public/private projection builder.
8. Workspaces with overlay VFS and optional materialization.
9. Local HTTP server with object push/pull and ACL enforcement.
10. Private merge requests and release-gate publication.
11. Git export of public projection.

## 23. Acceptance criteria

A prototype is successful when these scenarios work end-to-end:

### Scenario A: Track `.env` privately

1. Alice creates repo.
2. Alice tracks `src/index.ts` as public and `.env` as private to `group:maintainers`.
3. Alice pushes to server.
4. Bob, a maintainer, clones and can materialize `.env`.
5. Eve, a public user, clones public projection and cannot see `.env`, its blob, or its key grant.
6. Public export to Git contains no `.env`.

### Scenario B: Private security fix

1. Maintainer creates a private change fixing `/security/parser.ts`.
2. Maintainer opens private MR visible only to `group:security`.
3. Security reviewer approves.
4. MR merges into `main@private`.
5. `main@public` does not move and public users see nothing.
6. Release gate publishes at an explicit time.
7. Public projection updates after passing safety checks.

### Scenario C: Agent workspaces do not hijack branches

1. Create three workspaces from `main`.
2. Each workspace edits different files.
3. All workspaces can snapshot independently.
4. No workspace blocks another from starting at `main`.
5. Two workspaces can submit private MRs concurrently.

### Scenario D: Policy denies unauthorized writes

1. Contractor has read access to `/src/**` and write access to `/docs/**`.
2. Contractor attempts to modify `/ops/prod.env`.
3. Local CLI warns before snapshot.
4. Server rejects push even if local client is modified.

## 24. Open questions for later versions

- Should projections use cryptographic redaction proofs from day one, or is signed projection integrity sufficient for v0?
- How should history rewriting interact with private/public projection history?
- Should private path names be encrypted in the canonical tree, or is projection omission enough for most users?
- What is the best UX for group key rotation after member removal?
- Should the agent runtime use a FUSE mount, WASI filesystem, or pure in-process VFS adapter?
- How much GitHub compatibility is worth preserving versus building a separate review UI?
- Should package manager cache integration be part of core workspaces or a plugin?

## 25. External references used for terminology calibration

- Jujutsu documentation: snapshot-based VCS, working-copy snapshots, operation log, and bookmarks.
  - https://docs.jj-vcs.dev/latest/FAQ/
  - https://docs.jj-vcs.dev/latest/working-copy/
  - https://docs.jj-vcs.dev/latest/operation-log/
  - https://docs.jj-vcs.dev/latest/bookmarks/
- Git worktree documentation for current Git worktree behavior.
  - https://git-scm.com/docs/git-worktree

