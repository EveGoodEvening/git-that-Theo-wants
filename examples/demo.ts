// C10 end-to-end example: a local, in-process prototype exercise.
// It intentionally avoids network/server behavior and does not model production
// enforcement. The checks below stay on the gtw data model: MemoryStore,
// VirtualTree, snapshots/tags, visibility transitions, and public bundles.

import {
  Bookmarks,
  MemoryStore,
  OpLog,
  VisibilityLog,
  WorkspaceManager,
  buildAndAttachManifests,
  buildPublicExportBundle,
  createSnapshot,
  decryptSecret,
  derivePublicProjection,
  emptyTree,
  fromContentObject,
  importSecretKey,
  makeTree,
  matrixDecision,
  publish,
  putSecret,
  read as readPath,
  saveSnapshot,
  unpublish,
  verifyPublicExportBundle,
  write as writePath,
  type Snapshot,
  type SnapshotVisibility,
  type VisibilityState,
} from "../src/index.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

const ENV_PATH = ".env";
const PRIVATE_PATH = "notes/private-roadmap.md";
const PUBLIC_PATH = "src/public.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function bytesContain(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true;
  for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    let matched = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function ok(index: number, title: string, detail: string): void {
  console.log(`[ok] ${index}. ${title}: ${detail}`);
}

async function publicBundleFor(
  store: MemoryStore,
  snapshot: Snapshot,
  visibility: SnapshotVisibility,
) {
  const projection = await derivePublicProjection(
    [snapshot],
    new Map([[snapshot.id, visibility]]),
  );
  const bundle = await buildPublicExportBundle(projection.nodes, store);
  assert(await verifyPublicExportBundle(bundle), "public bundle integrity failed");
  return { ...projection, bundle };
}

async function main(): Promise<void> {
  const store = new MemoryStore();
  const log = new OpLog();
  const bookmarks = new Bookmarks(log);

  const envPlaintext = "DATABASE_URL=postgres://local-demo\nAPI_TOKEN=demo-secret\n";
  const secretKey = await importSecretKey(
    Uint8Array.from({ length: 32 }, (_, i) => i + 1),
  );
  const wrongKey = await importSecretKey(
    Uint8Array.from({ length: 32 }, (_, i) => 255 - i),
  );

  const envSecret = await putSecret(store, enc.encode(envPlaintext), secretKey);

  let tree = emptyTree();
  tree = makeTree(null, [[ENV_PATH, envSecret.id]]);
  tree = await writePath(
    tree,
    PUBLIC_PATH,
    enc.encode("export const visible = 'hello from the public subset';\n"),
    store,
  );
  tree = await writePath(
    tree,
    PRIVATE_PATH,
    enc.encode("private roadmap: do not publish this local note\n"),
    store,
  );

  const snapshot = await createSnapshot(
    null,
    tree.entries,
    1_700_000_000_000,
    "demo private PR snapshot",
    false,
  );
  saveSnapshot(snapshot, store);
  bookmarks.createBookmark("main", snapshot.id);
  bookmarks.createTag("demo-v1", snapshot.id);

  const storedEnv = store.getObject(envSecret.id);
  assert(storedEnv.kind === "secret-blob", ".env was not stored as a secret object");
  assert(
    !bytesContain(storedEnv.bytes, enc.encode(envPlaintext)),
    "stored .env bytes contain plaintext",
  );
  const restoredSecret = fromContentObject(storedEnv, envSecret.policyId);
  assert(
    dec.decode(await decryptSecret(restoredSecret, secretKey)) === envPlaintext,
    "authorized local key did not recover .env plaintext",
  );
  let deniedWrongKey = false;
  try {
    await decryptSecret(restoredSecret, wrongKey);
  } catch {
    deniedWrongKey = true;
  }
  assert(deniedWrongKey, "different local key unexpectedly decrypted .env");
  assert(snapshot.tree.get(ENV_PATH) === envSecret.id, ".env is not present in the snapshot tree");
  ok(1, "secret .env", "snapshot stores .env as a secret-blob and raw store bytes omit plaintext");

  const pathStateRecord: Record<string, VisibilityState> = {
    [ENV_PATH]: "private",
    [PRIVATE_PATH]: "private",
    [PUBLIC_PATH]: "public",
  };
  const pathStates = new Map(Object.entries(pathStateRecord));
  const publicVisibility: SnapshotVisibility = {
    state: "public",
    pathStates,
  };
  const publicBundle = await publicBundleFor(store, snapshot, publicVisibility);
  const publicEntries = publicBundle.bundle.manifest.publicEntries;
  const publicBlobId = snapshot.tree.get(PUBLIC_PATH);
  const privateBlobId = snapshot.tree.get(PRIVATE_PATH);
  assert(publicBlobId !== undefined, "public file missing from snapshot");
  assert(privateBlobId !== undefined, "private file missing from snapshot");
  assert(
    dec.decode(readPath(makeTree(snapshot.parentId, snapshot.tree), PRIVATE_PATH, store)) ===
      "private roadmap: do not publish this local note\n",
    "owner could not read private file through the virtual tree",
  );
  assert(publicEntries.some((entry) => entry.path === PUBLIC_PATH), "public file absent from public bundle");
  assert(!publicEntries.some((entry) => entry.path === PRIVATE_PATH), "private path leaked into public bundle");
  assert(!publicEntries.some((entry) => entry.path === ENV_PATH), ".env path leaked into public bundle");
  assert(publicBundle.bundle.objects.has(publicBlobId), "public blob absent from public bundle objects");
  assert(!publicBundle.bundle.objects.has(privateBlobId), "private blob leaked into public bundle objects");
  assert(!publicBundle.bundle.objects.has(envSecret.id), ".env secret object leaked into public bundle objects");
  ok(2, "private file", "owner reads the private file, while the public bundle contains only the public path");

  const visibility = new VisibilityLog();
  const privateVisibility: SnapshotVisibility = {
    state: visibility.get(snapshot.id),
    pathStates,
  };
  assert(privateVisibility.state === "private", "new PR-equivalent snapshot was not private by default");
  assert(matrixDecision(privateVisibility.state, "read", "peer") === "deny", "private peer read was not denied");
  const beforePublish = await publicBundleFor(store, snapshot, privateVisibility);
  assert(beforePublish.bundle.manifest.publicEntries.length === 0, "private PR appeared in public bundle before publish");

  publish(log, visibility, snapshot.id, 1_700_000_000_100);
  assert(visibility.get(snapshot.id) === "public", "publish did not make snapshot public");
  assert(matrixDecision(visibility.get(snapshot.id), "read", "peer") === "allow", "published peer read was not allowed");
  const afterPublishVisibility: SnapshotVisibility = {
    state: visibility.get(snapshot.id),
    pathStates,
  };
  const afterPublish = await publicBundleFor(store, snapshot, afterPublishVisibility);
  assert(afterPublish.bundle.manifest.publicEntries.length === 1, "published bundle should expose one public path");

  unpublish(log, visibility, snapshot.id, 1_700_000_000_200);
  assert(visibility.get(snapshot.id) === "private", "unpublish did not re-privatize future visibility");
  assert(matrixDecision(visibility.get(snapshot.id), "read", "peer") === "deny", "unpublished peer read was not denied");
  const afterUnpublish = await publicBundleFor(store, snapshot, {
    state: visibility.get(snapshot.id),
    pathStates,
  });
  assert(afterUnpublish.bundle.manifest.publicEntries.length === 0, "future public bundle still exposed unpublished snapshot");
  const visibilityEvents = log.list().filter((event) => event.kind === "publish" || event.kind === "unpublish");
  assert(
    visibilityEvents.map((event) => event.kind).join(",") === "publish,unpublish",
    "publish/unpublish op-log sequence was not append-only in order",
  );
  ok(3, "private PR -> publish -> unpublish", "private by default, publish exposes the public subset, unpublish hides it for future bundles");

  const attached = await buildAndAttachManifests(snapshot, publicVisibility, store);
  assert(attached.updatedSnapshot.id === snapshot.id, "manifest refs changed the SnapshotId");
  assert(bookmarks.getTag("demo-v1") === snapshot.id, "tag does not point at the demo snapshot");
  assert(store.getManifestRefs(snapshot.id).publicManifestRef === attached.publicManifestRef, "public manifest ref was not attached");
  assert(store.getManifestRefs(snapshot.id).privateManifestRef === attached.privateManifestRef, "private manifest ref was not attached");
  assert(
    log.list().some((event) => event.kind === "tag-move" && event.to === snapshot.id),
    "tag creation was not recorded in the op-log",
  );
  ok(4, "snapshot + tag", "content-addressed snapshot is tagged as demo-v1 and manifest refs attach without changing its id");

  const manager = new WorkspaceManager(store, log, bookmarks);
  const workspaceA = await manager.createAtRef("main", { now: () => 1_700_000_000_300 });
  const workspaceB = await manager.createAtRef("main", { now: () => 1_700_000_000_400 });
  assert(workspaceA.currentSnapshotId === snapshot.id, "workspace A did not check out main");
  assert(workspaceB.currentSnapshotId === snapshot.id, "workspace B did not check out main");
  assert(workspaceA.ref === "main" && workspaceB.ref === "main", "workspaces did not share the same ref pointer");
  await workspaceA.write("scratch/a.txt", enc.encode("workspace A local change\n"));
  await workspaceB.write("scratch/b.txt", enc.encode("workspace B local change\n"));
  const boundaryA = await workspaceA.commandBoundary({
    timestamp: 1_700_000_000_500,
    message: "workspace A snapshot",
  });
  const boundaryB = await workspaceB.commandBoundary({
    timestamp: 1_700_000_000_600,
    message: "workspace B snapshot",
  });
  assert(boundaryA !== null && boundaryB !== null, "workspace command boundaries did not snapshot changes");
  assert(boundaryA.snapshot.parentId === snapshot.id, "workspace A did not descend from the shared base");
  assert(boundaryB.snapshot.parentId === snapshot.id, "workspace B did not descend from the shared base");
  assert(boundaryA.snapshot.id !== boundaryB.snapshot.id, "workspace snapshots did not diverge independently");
  assert(bookmarks.getBookmark("main") === snapshot.id, "workspace checkout moved or locked main");
  ok(5, "two workspaces same ref", "two workspaces checked out main and snapshotted independent changes without moving the ref");

  assert(store instanceof MemoryStore, "demo did not use MemoryStore");
  assert(store.listSnapshots().length === 3, "unexpected snapshot count in in-memory store");
  assert(manager.list().length === 2, "workspace manager did not keep both in-memory workspaces");
  ok(6, "in-memory no real-FS clone", "all repository state stayed in MemoryStore/VirtualTree and public export used an in-memory bundle");

  console.log("C10 demo complete: all six README pain points exercised locally.");
}

await main();
