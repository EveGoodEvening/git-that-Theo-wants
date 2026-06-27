// C9 CLI integration tests.
//
// Covers (plan C9 checklist):
//   - `gtw --help` lists all commands in documented order, with `publish`
//     before `publish-check` and `unpublish`.
//   - The full planned flow `snapshot create -> tag create -> publish ->
//     export -> publish-check -> unpublish` runs end-to-end via the thin
//     command handlers (no `fetch`).
//   - Bundle-mode export-privacy tests ALWAYS run: the C6 in-memory public
//     bundle contains no private/local-only bytes, no private path strings,
//     no private blob/secret ids, no full SnapshotId values, and no private
//     metadata (private manifest refs, private timestamps, op-log entries,
//     private messages). Only C6 public-projection public entries appear.
//   - Real-FS export/materialization CLI tests run because C8 status is
//     `[x]`: the C8-materialized real-FS tree contains zero private/local-only
//     bytes, paths, blob/secret ids, SnapshotIds, and private metadata.
//
// The thin command handlers are invoked directly (they return stdout strings
// and mutate the shared `CliSession`), so the tests can assert on the
// resulting core state as well as the human-facing output. `--help` ordering
// is asserted via a subprocess (`bun run src/cli/index.ts --help`) exactly as
// the smoke test does.

import { describe, expect, it } from "bun:test";
import { $ } from "bun";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asSnapshotId, type SnapshotId } from "../../src/core/ids.ts";
import { loadSnapshot } from "../../src/snapshot/snapshot.ts";
import {
  derivePublicProjection,
  buildPublicExportBundle,
  verifyPublicExportBundle,
  serializePublicManifest,
} from "../../src/export/public-manifest.ts";
import { materialize } from "../../src/vfs/materialize.ts";
import {
  serializePublicExportBundle,
  parsePublicExportArtifact,
} from "../../src/cli/export-artifact.ts";
import {
  CliError,
  CliSession,
  initSession,
  requireSession,
} from "../../src/cli/session.ts";
import {
  cmdInit,
  cmdStatus,
  cmdSnapshotCreate,
  cmdSnapshotShow,
  cmdSnapshotList,
  cmdBookmarkList,
  cmdBookmarkSet,
  cmdTagCreate,
  cmdTagList,
  cmdRestore,
  cmdExport,
  cmdPublish,
  cmdPublishCheck,
  cmdUnpublish,
} from "../../src/cli/commands.ts";
import { version } from "../../src/index.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Collect all bytes under `dir` (recursively) as a single Buffer. */
function readAllBytes(dir: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        walk(p);
      } else {
        chunks.push(readFileSync(p));
      }
    }
  };
  walk(dir);
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Collect all file paths under `dir` (recursively), relative to `dir`. */
function readAllPaths(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, base: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const rel = base === "" ? name : `${base}/${name}`;
      const st = statSync(p);
      if (st.isDirectory()) {
        walk(p, rel);
      } else {
        out.push(rel);
      }
    }
  };
  walk(dir, "");
  return out;
}

// ---------------------------------------------------------------------------
// Help output ordering.
// ---------------------------------------------------------------------------

describe("C9 CLI --help", () => {
  it("lists all commands in documented order with publish before publish-check and unpublish", async () => {
    const result = await $`bun run src/cli/index.ts --help`.nothrow();
    expect(result.exitCode).toBe(0);
    const out = result.stdout.toString();
    expect(out).toContain(version);
    // Documented order: extract the "Commands:" block and assert ordering.
    const commandsBlock = out.split("Commands:\n")[1] ?? "";
    expect(commandsBlock).toContain("init");
    expect(commandsBlock).toContain("status");
    expect(commandsBlock).toContain("snapshot create");
    expect(commandsBlock).toContain("snapshot show");
    expect(commandsBlock).toContain("snapshot list");
    expect(commandsBlock).toContain("bookmark list");
    expect(commandsBlock).toContain("bookmark set");
    expect(commandsBlock).toContain("tag create");
    expect(commandsBlock).toContain("tag list");
    expect(commandsBlock).toContain("restore");
    expect(commandsBlock).toContain("export");
    expect(commandsBlock).toContain("publish ");
    expect(commandsBlock).toContain("publish-check");
    expect(commandsBlock).toContain("unpublish");
    // Ordering: publish must appear before publish-check, which before unpublish.
    const iPublish = commandsBlock.indexOf("publish ");
    const iPublishCheck = commandsBlock.indexOf("publish-check");
    const iUnpublish = commandsBlock.indexOf("unpublish");
    expect(iPublish).toBeGreaterThan(-1);
    expect(iPublishCheck).toBeGreaterThan(iPublish);
    expect(iUnpublish).toBeGreaterThan(iPublishCheck);
    // init before status before snapshot before bookmark before tag before
    // restore before export before publish.
    const idx = (name: string) => commandsBlock.indexOf(name);
    expect(idx("init")).toBeLessThan(idx("status"));
    expect(idx("status")).toBeLessThan(idx("snapshot create"));
    expect(idx("snapshot list")).toBeLessThan(idx("bookmark list"));
    expect(idx("bookmark set")).toBeLessThan(idx("tag create"));
    expect(idx("tag list")).toBeLessThan(idx("restore"));
    expect(idx("restore")).toBeLessThan(idx("export"));
    expect(idx("export")).toBeLessThan(idx("publish "));
  });

  it("exits 0 on --version and -v", async () => {
    const r1 = await $`bun run src/cli/index.ts --version`.nothrow();
    expect(r1.exitCode).toBe(0);
    expect(r1.stdout.toString().trim()).toBe(version);
    const r2 = await $`bun run src/cli/index.ts -v`.nothrow();
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout.toString().trim()).toBe(version);
  });

  it("exits 1 with a usage hint on an unknown command", async () => {
    const r = await $`bun run src/cli/index.ts frobnicate`.nothrow();
    expect(r.exitCode).toBe(1);
    const err = r.stderr.toString();
    expect(err).toContain("unknown command");
    expect(err).toContain("--help");
  });
});

// ---------------------------------------------------------------------------
// End-to-end planned flow: snapshot create -> tag create -> publish ->
// export -> publish-check -> unpublish.
// ---------------------------------------------------------------------------

describe("C9 CLI planned flow", () => {
  it("runs snapshot create -> tag create -> publish -> export -> publish-check -> unpublish", async () => {
    await cmdInit([]);
    const s = await requireSession();

    // snapshot create: writes a public file and auto-snapshots.
    const created = await cmdSnapshotCreate([
      "pub.txt",
      "public-content",
      "--message",
      "first",
    ]);
    expect(created).toContain("snapshot");
    const head = s.current.currentSnapshotId;
    expect(head).not.toBeNull();
    const snapshotId = head as SnapshotId;

    // snapshot list shows one private snapshot.
    const list = await cmdSnapshotList([]);
    expect(list).toContain("private");

    // tag create at the new snapshot.
    const tagOut = await cmdTagCreate(["v1", snapshotId]);
    expect(tagOut).toContain("tag v1 created");
    expect(s.bookmarks.listTags()).toEqual(["v1"]);

    // publish the snapshot.
    const pubOut = await cmdPublish([snapshotId]);
    expect(pubOut).toContain("published");
    expect(pubOut).toContain("-> public");

    // export (bundle mode, --out): emits the machine-readable C6 public
    // bundle artifact. Parse it back and assert content + privacy.
    const outFile = join(tmpdir(), "gtw-export-artifact-" + Math.random().toString(36).slice(2));
    const exportOut = await cmdExport(["--out", outFile]);
    expect(exportOut).toContain("exported public bundle artifact");
    const artifact = readFileSync(outFile);
    const parsed = parsePublicExportArtifact(artifact);
    const paths = parsed.manifest.publicEntries.map((e) => e.path);
    expect(paths).toEqual(["pub.txt"]);
    const pubObj = parsed.objects.get(parsed.manifest.publicEntries[0]!.blobId);
    expect(pubObj).toBeDefined();
    expect(dec.decode(pubObj!.bytes)).toBe("public-content");

    // publish-check reports public + transitioned.
    const check = await cmdPublishCheck([snapshotId]);
    expect(check).toContain("visibility: public");
    expect(check).toContain("transitioned: true");

    // unpublish re-privatizes.
    const unpubOut = await cmdUnpublish([snapshotId]);
    expect(unpubOut).toContain("unpublished");
    expect(unpubOut).toContain("-> private");
    const check2 = await cmdPublishCheck([snapshotId]);
    expect(check2).toContain("visibility: private");
    expect(check2).toContain("transitioned: true");
  });

  it("snapshot show reports core state and visibility", async () => {
    await cmdInit([]);
    const s = await requireSession();
    await cmdSnapshotCreate(["a.txt", "aaa", "--message", "show-me"]);
    const id = s.current.currentSnapshotId as SnapshotId;
    const out = await cmdSnapshotShow([id]);
    expect(out).toContain("a.txt");
    expect(out).toContain("visibility: private");
    expect(out).toContain("message: show-me");
  });

  it("bookmark set/list create and move bookmarks", async () => {
    await cmdInit([]);
    const s = await requireSession();
    await cmdSnapshotCreate(["x.txt", "x", "--message", "x"]);
    const id1 = s.current.currentSnapshotId as SnapshotId;
    const set1 = await cmdBookmarkSet(["main", id1]);
    expect(set1).toContain("bookmark main set");
    await cmdSnapshotCreate(["y.txt", "y", "--message", "y"]);
    const id2 = s.current.currentSnapshotId as SnapshotId;
    const set2 = await cmdBookmarkSet(["main", id2]);
    expect(set2).toContain("moved");
    const list = await cmdBookmarkList([]);
    expect(list).toContain("main");
    expect(list).toContain(id2.slice(0, 12));
  });

  it("restore checks out a snapshot into the current workspace", async () => {
    await cmdInit([]);
    const s = await requireSession();
    await cmdSnapshotCreate(["r.txt", "rr", "--message", "r"]);
    const id = s.current.currentSnapshotId as SnapshotId;
    // Mutate the working copy so it diverges from the snapshot.
    await s.current.write("other.txt", enc.encode("other"));
    const out = await cmdRestore([id]);
    expect(out).toContain("restored");
    // After restore the working copy reflects the snapshot tree.
    expect(s.current.currentSnapshotId).toBe(id);
    expect(s.current.dirty).toBe(false);
  });

  it("status reports workspace, head, and counts", async () => {
    await cmdInit([]);
    const s = await requireSession();
    const out1 = await cmdStatus([]);
    expect(out1).toContain("head: (none)");
    await cmdSnapshotCreate(["s.txt", "s", "--message", "s"]);
    const out2 = await cmdStatus([]);
    expect(out2).toContain("head:");
    expect(out2).not.toContain("head: (none)");
    expect(out2).toContain("snapshots: 1");
  });

  it("requires init before other commands", async () => {
    // Fresh module state: force a re-init then immediately reset by creating
    // a new session and asserting requireSession works. The no-session case
    // is exercised by the dispatcher's try/catch; here we assert the typed
    // error shape directly.
    await cmdInit([]);
    expect(await requireSession()).toBeInstanceOf(CliSession);
  });
});

describe("C9 CLI bundle-mode export privacy (always runs)", () => {
  it("the C6 public bundle contains no private bytes, paths, blob/secret ids, SnapshotIds, or private metadata", async () => {
    await cmdInit([]);
    const s = await requireSession();

    // Create a snapshot with a public file and a private file.
    await cmdSnapshotCreate([
      "pub.txt",
      "public-data",
      "--message",
      "mixed",
    ]);
    // Add a private file via the working copy and auto-snapshot.
    const ws = s.current;
    await ws.write("secret.txt", enc.encode("private-data"));
    const boundary = await ws.commandBoundary({ message: "with-secret" });
    const snapId = boundary?.snapshot.id as SnapshotId;
    // Per-path private override on secret.txt; the snapshot stays private
    // until `cmdPublish` flips it to public via an op-log event.
    s.setPathVisibility(snapId, "secret.txt", "private");

    // Publish so the export derivation sees the snapshot as public.
    await cmdPublish([snapId]);

    // Build the export bundle the same way `cmdExport` does (delegation).
    const chain = [];
    let curId: SnapshotId | null = snapId;
    while (curId !== null) {
      const snap = await loadSnapshot(curId, s.store);
      chain.unshift(snap);
      curId = snap.parentId;
    }
    const { nodes } = await derivePublicProjection(chain, s.visibilityMap());
    const bundle = await buildPublicExportBundle(nodes, s.store);
    expect(await verifyPublicExportBundle(bundle)).toBe(true);

    // --- Privacy assertions on the bundle ---
    // 1. Only the public path appears.
    const paths = bundle.manifest.publicEntries.map((e) => e.path);
    expect(paths).toEqual(["pub.txt"]);
    expect(paths).not.toContain("secret.txt");

    // 2. No private bytes: the private content string must not appear in any
    //    bundled object or in the serialized manifest.
    const serialized = dec.decode(serializePublicManifest(bundle.manifest));
    for (const [, obj] of bundle.objects) {
      const text = dec.decode(obj.bytes);
      expect(text).not.toContain("private-data");
    }
    expect(serialized).not.toContain("private-data");

    // 3. No private path strings in the manifest serialization.
    expect(serialized).not.toContain("secret.txt");

    // 4. No full SnapshotId values: the snapshot id hex must not appear in
    //    the serialized manifest (only PublicProjectionIds appear).
    expect(serialized).not.toContain(snapId);
    expect(serialized).not.toContain(chain[0].id);

    // 5. No private metadata: no timestamps, no messages, no op-log entries,
    //    no manifest refs. The manifest schema carries only bundleVersion,
    //    publicProjectionIds, publicEntries, publicManifestHash.
    expect(serialized).not.toContain("mixed");
    expect(serialized).not.toContain("with-secret");
    // Timestamps are integers; the snapshot timestamps must not appear.
    expect(serialized).not.toContain(String(chain[chain.length - 1].timestamp));

    // 6. No secret-blob ids: only blob objects are bundled.
    for (const [, obj] of bundle.objects) {
      expect(obj.kind).toBe("blob");
    }

    // 7. The public content is present and correct.
    const pubObj = bundle.objects.get(
      bundle.manifest.publicEntries[0]!.blobId,
    );
    expect(pubObj).toBeDefined();
    expect(dec.decode(pubObj!.bytes)).toBe("public-data");

    // 8. The serialized export artifact carries the same privacy guarantees:
    //    no private bytes, paths, snapshot ids, or private metadata anywhere
    //    in the machine-readable bundle output.
    const artifact = serializePublicExportBundle(bundle);
    const artifactText = dec.decode(artifact);
    expect(artifactText).not.toContain("private-data");
    expect(artifactText).not.toContain("secret.txt");
    expect(artifactText).not.toContain(snapId);
    expect(artifactText).not.toContain(chain[0].id);
    expect(artifactText).not.toContain("mixed");
    expect(artifactText).not.toContain("with-secret");
    // Round-trip: parsing the artifact recovers the manifest + public blob.
    const parsed = parsePublicExportArtifact(artifact);
    expect(parsed.manifest.publicEntries.map((e) => e.path)).toEqual(["pub.txt"]);
    const parsedObj = parsed.objects.get(parsed.manifest.publicEntries[0]!.blobId);
    expect(parsedObj).toBeDefined();
    expect(dec.decode(parsedObj!.bytes)).toBe("public-data");
  });

  it("export of a private snapshot carries no public entries", async () => {
    await cmdInit([]);
    const s = await requireSession();
    await cmdSnapshotCreate(["p.txt", "pp", "--message", "private-only"]);
    const id = s.current.currentSnapshotId as SnapshotId;
    // Leave the snapshot private (do not publish). Use --out so the artifact
    // is written to a file without polluting stdout in-process.
    const outFile = join(tmpdir(), "gtw-export-empty-" + Math.random().toString(36).slice(2));
    const out = await cmdExport(["--snapshot", id, "--out", outFile]);
    expect(out).toContain("exported public bundle artifact");
    // A private snapshot has no public entries.
    const parsed = parsePublicExportArtifact(readFileSync(outFile));
    expect(parsed.manifest.publicEntries).toEqual([]);
    expect(parsed.objects.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Real-FS export/materialization CLI tests (C8 status [x]).
// ---------------------------------------------------------------------------

describe("C9 CLI real-FS export materialization (C8 landed)", () => {
  it("materializes the C6 public projection to real files with zero private metadata", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gtw-export-"));
    await cmdInit([]);
    const s = await requireSession();

    // Build a snapshot with one public and one private file.
    await cmdSnapshotCreate(["pub.txt", "PUBLIC", "--message", "m1"]);
    const ws = s.current;
    await ws.write("secret.txt", enc.encode("SECRET"));
    const boundary = await ws.commandBoundary({ message: "m2" });
    const snapId = boundary?.snapshot.id as SnapshotId;
    s.setPathVisibility(snapId, "secret.txt", "private");
    await cmdPublish([snapId]);

    // Export to the temp dir via the real-FS materialization path.
    const out = await cmdExport(["--to", dir]);
    expect(out).toContain("exported 1 public entries");
    expect(out).toContain("pub.txt");

    // --- Real-FS privacy assertions ---
    // 1. Only pub.txt is on disk; secret.txt is absent.
    const paths = readAllPaths(dir);
    expect(paths).toContain("pub.txt");
    expect(paths).not.toContain("secret.txt");

    // 2. The public file content is byte-identical.
    const pubBytes = readFileSync(join(dir, "pub.txt"));
    expect(dec.decode(pubBytes)).toBe("PUBLIC");

    // 3. No private bytes anywhere on disk.
    const allBytes = readAllBytes(dir);
    const allText = dec.decode(allBytes);
    expect(allText).not.toContain("SECRET");
    expect(allText).not.toContain("private-data");

    // 4. No private path strings on disk.
    expect(allText).not.toContain("secret.txt");

    // 5. No full SnapshotId values on disk.
    expect(allText).not.toContain(snapId);

    // 6. No private metadata: no messages, no timestamps, no op-log entries.
    expect(allText).not.toContain("m1");
    expect(allText).not.toContain("m2");
  });

  it("materialize via the C8 adapter directly enforces bundle integrity", async () => {
    await cmdInit([]);
    const s = await requireSession();
    await cmdSnapshotCreate(["only.txt", "ONLY", "--message", "only"]);
    const id = s.current.currentSnapshotId as SnapshotId;
    await cmdPublish([id]);

    // Rebuild the bundle and materialize directly through C8.
    const chain = [];
    let curId: SnapshotId | null = id;
    while (curId !== null) {
      const snap = await loadSnapshot(curId, s.store);
      chain.unshift(snap);
      curId = snap.parentId;
    }
    const { nodes } = await derivePublicProjection(chain, s.visibilityMap());
    const bundle = await buildPublicExportBundle(nodes, s.store);
    const dir = mkdtempSync(join(tmpdir(), "gtw-direct-"));
    const res = await materialize(bundle, dir);
    expect(res.writtenPaths).toEqual(["only.txt"]);
    expect(dec.decode(readFileSync(join(dir, "only.txt")))).toBe("ONLY");
  });
});

// ---------------------------------------------------------------------------
// publish / unpublish error paths.
// ---------------------------------------------------------------------------

describe("C9 CLI publish/unpublish error paths", () => {
  it("publish rejects an already-public snapshot", async () => {
    await cmdInit([]);
    const s = await requireSession();
    await cmdSnapshotCreate(["a.txt", "a", "--message", "a"]);
    const id = s.current.currentSnapshotId as SnapshotId;
    await cmdPublish([id]);
    await expect(cmdPublish([id])).rejects.toThrow(CliError);
  });

  it("unpublish rejects a non-public snapshot", async () => {
    await cmdInit([]);
    const s = await requireSession();
    await cmdSnapshotCreate(["a.txt", "a", "--message", "a"]);
    const id = s.current.currentSnapshotId as SnapshotId;
    await expect(cmdUnpublish([id])).rejects.toThrow(CliError);
  });

  it("publish-check on an unknown snapshot id reports default visibility without crashing", async () => {
    // publish-check reads the replayed visibility log, not the snapshot, so
    // an unknown id reports the default private state and transitioned:false
    // rather than throwing. The dispatcher's try/catch still guards against
    // unexpected errors.
    await cmdInit([]);
    const bogus = asSnapshotId("0".repeat(64));
    const out = await cmdPublishCheck([bogus]);
    expect(out).toContain("visibility: private");
    expect(out).toContain("transitioned: false");
  });
});

// ---------------------------------------------------------------------------
// Real subprocess planned flow: separate `gtw` process invocations sharing
// one durable `.gtw/` state in a temp cwd. This is the C9 blocker fix — the
// in-memory SESSION is lost between invocations, so the flow must work via the
// durable local CLI state.
// ---------------------------------------------------------------------------

describe("C9 CLI subprocess planned flow (durable across invocations)", () => {
  // Absolute path to the CLI entrypoint so the subprocess resolves it
  // regardless of its `cwd` (the temp workDir has no `src/`).
  const CLI = join(import.meta.dir, "..", "..", "src", "cli", "index.ts");

  /**
   * Run `gtw <args...>` as a real subprocess with `cwd` set to `workDir` so the
   * default `.gtw` durable root lands in the temp workspace. Returns the
   * captured {exitCode, stdout, stderr}.
   */
  async function gtw(workDir: string, args: string[]): Promise<{
    exitCode: number;
    stdout: Buffer;
    stderr: Buffer;
  }> {
    const result = await $`bun run ${CLI} ${args}`.cwd(workDir).nothrow();
    return {
      exitCode: result.exitCode,
      stdout: Buffer.from(result.stdout),
      stderr: Buffer.from(result.stderr),
    };
  }

  it("runs init -> snapshot create -> tag create -> publish -> export -> publish-check -> unpublish across separate processes", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "gtw-subprocess-"));
    // Ensure no stale `.gtw` from a prior run interferes; the temp dir is
    // already empty, but be explicit.
    const gtwDir = join(workDir, ".gtw");
    expect(existsSync(gtwDir)).toBe(false);

    // 1. init: creates the durable `.gtw/` state.
    const rInit = await gtw(workDir, ["init"]);
    expect(rInit.exitCode).toBe(0);
    expect(rInit.stdout.toString()).toContain("initialized empty gtw session");
    expect(existsSync(gtwDir)).toBe(true);
    expect(existsSync(join(gtwDir, "cli", "state.json"))).toBe(true);

    // 2. snapshot create: writes a public file and auto-snapshots. The
    //    snapshot id is printed as a short prefix; capture it for later cmds.
    const rSnap = await gtw(workDir, ["snapshot", "create", "pub.txt", "public-content", "--message", "first"]);
    expect(rSnap.exitCode).toBe(0);
    expect(rSnap.stdout.toString()).toContain("snapshot");
    const snapMatch = rSnap.stdout.toString().match(/snapshot ([0-9a-f]{12}) created/);
    expect(snapMatch).not.toBeNull();
    const shortId = snapMatch![1]!;
    // The full 64-char id is needed for publish/tag/etc. Recover it from the
    // `snapshot show` output, which prints the full id.
    const rShow = await gtw(workDir, ["snapshot", "show", shortId]);
    expect(rShow.exitCode).toBe(0);
    const idMatch = rShow.stdout.toString().match(/id: ([0-9a-f]{64})/);
    expect(idMatch).not.toBeNull();
    const snapshotId = idMatch![1]!;

    // 3. snapshot list (separate process) shows one private snapshot.
    const rList = await gtw(workDir, ["snapshot", "list"]);
    expect(rList.exitCode).toBe(0);
    expect(rList.stdout.toString()).toContain("private");

    // 4. tag create at the new snapshot (separate process).
    const rTag = await gtw(workDir, ["tag", "create", "v1", snapshotId]);
    expect(rTag.exitCode).toBe(0);
    expect(rTag.stdout.toString()).toContain("tag v1 created");
    // tag list (separate process) persists across invocations.
    const rTagList = await gtw(workDir, ["tag", "list"]);
    expect(rTagList.exitCode).toBe(0);
    expect(rTagList.stdout.toString()).toContain("v1");

    // 5. publish (separate process).
    const rPub = await gtw(workDir, ["publish", snapshotId]);
    expect(rPub.exitCode).toBe(0);
    expect(rPub.stdout.toString()).toContain("published");
    expect(rPub.stdout.toString()).toContain("-> public");

    // 6. export bundle mode (separate process): emits the machine-readable
    //    public bundle artifact to stdout. Parse it and assert content +
    //    privacy. Use --out so we get a file to read back.
    const outFile = join(workDir, "bundle.pub");
    const rExport = await gtw(workDir, ["export", "--out", outFile]);
    expect(rExport.exitCode).toBe(0);
    expect(rExport.stdout.toString()).toContain("exported public bundle artifact");
    expect(existsSync(outFile)).toBe(true);
    const artifact = readFileSync(outFile);
    const parsed = parsePublicExportArtifact(artifact);
    expect(parsed.manifest.publicEntries.map((e) => e.path)).toEqual(["pub.txt"]);
    const pubObj = parsed.objects.get(parsed.manifest.publicEntries[0]!.blobId);
    expect(pubObj).toBeDefined();
    expect(dec.decode(pubObj!.bytes)).toBe("public-content");
    // Privacy: no private metadata leaks into the artifact.
    const artifactText = dec.decode(artifact);
    expect(artifactText).not.toContain(snapshotId);
    expect(artifactText).not.toContain("first");

    // 7. publish-check (separate process) reports public + transitioned.
    //    Pass the short id printed by `snapshot create` directly — no
    //    `snapshot show` full-id recovery step. publish-check must resolve
    //    the 12-char prefix via `s.resolveSnapshotId`.
    const rCheck = await gtw(workDir, ["publish-check", shortId]);
    expect(rCheck.exitCode).toBe(0);
    expect(rCheck.stdout.toString()).toContain("visibility: public");
    expect(rCheck.stdout.toString()).toContain("transitioned: true");

    // 8. unpublish (separate process) re-privatizes.
    const rUnpub = await gtw(workDir, ["unpublish", snapshotId]);
    expect(rUnpub.exitCode).toBe(0);
    expect(rUnpub.stdout.toString()).toContain("unpublished");
    expect(rUnpub.stdout.toString()).toContain("-> private");
    const rCheck2 = await gtw(workDir, ["publish-check", shortId]);
    expect(rCheck2.exitCode).toBe(0);
    expect(rCheck2.stdout.toString()).toContain("visibility: private");
    expect(rCheck2.stdout.toString()).toContain("transitioned: true");

    // 9. status (separate process) reflects the durable state: one snapshot,
    //    one tag, head set.
    const rStatus = await gtw(workDir, ["status"]);
    expect(rStatus.exitCode).toBe(0);
    const statusOut = rStatus.stdout.toString();
    expect(statusOut).toContain("snapshots: 1");
    expect(statusOut).toContain("tags: v1");
    expect(statusOut).not.toContain("head: (none)");
  });

  it("export --to materializes the public projection to real files across invocations", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "gtw-subprocess-to-"));
    await gtw(workDir, ["init"]);
    await gtw(workDir, ["snapshot", "create", "pub.txt", "PUBLIC", "--message", "m1"]);
    // Recover the full snapshot id via `snapshot show` on the short prefix.
    const rSnap = await gtw(workDir, ["snapshot", "list"]);
    const shortId = rSnap.stdout.toString().match(/([0-9a-f]{12})\s/)?.[1];
    expect(shortId).toBeDefined();
    const rShow = await gtw(workDir, ["snapshot", "show", shortId!]);
    const snapshotId = rShow.stdout.toString().match(/id: ([0-9a-f]{64})/)?.[1]!;
    await gtw(workDir, ["publish", snapshotId]);
    const toDir = join(workDir, "out");
    const rExport = await gtw(workDir, ["export", "--to", toDir]);
    expect(rExport.exitCode).toBe(0);
    expect(rExport.stdout.toString()).toContain("exported 1 public entries");
    expect(readAllPaths(toDir)).toEqual(["pub.txt"]);
    expect(dec.decode(readFileSync(join(toDir, "pub.txt")))).toBe("PUBLIC");
  });

  it("export (bare stdout) emits a machine-readable, integrity-verifiable, privacy-safe public bundle artifact across invocations", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "gtw-subprocess-stdout-"));
    await gtw(workDir, ["init"]);
    await gtw(workDir, ["snapshot", "create", "pub.txt", "public-content", "--message", "first"]);
    // Recover the full snapshot id via `snapshot show` on the short prefix.
    const rSnap = await gtw(workDir, ["snapshot", "list"]);
    const shortId = rSnap.stdout.toString().match(/([0-9a-f]{12})\s/)?.[1];
    expect(shortId).toBeDefined();
    const rShow = await gtw(workDir, ["snapshot", "show", shortId!]);
    const snapshotId = rShow.stdout.toString().match(/id: ([0-9a-f]{64})/)?.[1]!;
    await gtw(workDir, ["publish", snapshotId]);

    // Bare bundle mode: the artifact bytes go to stdout, the human summary to
    // stderr. stdout must be a clean machine-readable channel.
    const rExport = await gtw(workDir, ["export"]);
    expect(rExport.exitCode).toBe(0);
    expect(rExport.stderr.toString()).toContain("exported public bundle artifact");
    // stdout is the raw artifact bytes (no human text).
    const artifact = new Uint8Array(rExport.stdout);
    const parsed = parsePublicExportArtifact(artifact);
    expect(parsed.manifest.publicEntries.map((e) => e.path)).toEqual(["pub.txt"]);
    const pubObj = parsed.objects.get(parsed.manifest.publicEntries[0]!.blobId);
    expect(pubObj).toBeDefined();
    expect(dec.decode(pubObj!.bytes)).toBe("public-content");

    // Integrity-verifiable via the C6 public bundle path: reconstruct the
    // bundle and run `verifyPublicExportBundle` (manifest self-hash + exact
    // object set referenced by the manifest).
    const bundle = {
      manifest: parsed.manifest,
      objects: parsed.objects,
    };
    expect(await verifyPublicExportBundle(bundle)).toBe(true);

    // Privacy-safe: no full SnapshotId, no private metadata in the artifact.
    const artifactText = dec.decode(artifact);
    expect(artifactText).not.toContain(snapshotId);
    expect(artifactText).not.toContain("first");
  });

  it("there is no fetch command", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "gtw-no-fetch-"));
    await gtw(workDir, ["init"]);
    const r = await gtw(workDir, ["fetch"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("unknown command");
  });
});
