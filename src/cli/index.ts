#!/usr/bin/env bun
// gtw CLI entrypoint. C9 ships the thin command surface over the gtw core:
//   init, status, snapshot create/show/list, bookmark list/set,
//   tag create/list, restore, export, publish, publish-check, unpublish
//
// The dispatcher is parsing + delegation only: it routes a command to a thin
// handler in `commands.ts`, which delegates to the core/vfs/snapshot/policy/
// workspace/fs APIs through the `CliSession`. There is no `fetch` command
// (plan §5: no network transfer; public-peer visibility is in-process via the
// public manifest/bundle).
//
// Commands are listed in the documented order (plan C9 / §4), with `publish`
// before `publish-check` and `unpublish`.
import { existsSync } from "node:fs";

import { version } from "../index.ts";
import {
  CliError,
  getSession,
  setSessionRoot,
} from "./session.ts";
// Importing the durable module registers its session factory so the dispatcher
// can back the CLI with on-disk state under `.gtw/` (or `--root <dir>`).
import "./durable.ts";
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
} from "./commands.ts";

const HELP = `gtw ${version}
Git that Theo wants — prototype source control.

Usage:
  gtw --help, -h        Show this help and exit
  gtw --version, -v     Print version and exit
  gtw <command> ...     Run a command

Commands:
  init                       Initialize a fresh in-memory gtw session
  status                     Show workspace, head, bookmarks, tags, snapshot count
  snapshot create <path> <content> [--message <m>]
                             Write a file and auto-snapshot the working copy
  snapshot show <id>         Show a snapshot's core state and visibility
  snapshot list              List all stored snapshot ids and visibility
  bookmark list              List bookmarks and their targets
  bookmark set <name> <id>   Create or move a bookmark to a snapshot
  tag create <name> <id>     Create a tag pointing at a snapshot
  tag list                   List tags and their targets
  restore <id>               Check out a snapshot into the current workspace
  export [--to <dir>] [--snapshot <id>]
                             Export the C6 public bundle (or materialize to <dir>)
  publish <id>               Transition a snapshot to public (op-log event)
  publish-check <id>         Report a snapshot's current visibility
  unpublish <id>             Re-privatize a public snapshot (new op-log event)

There is no fetch command; public-peer visibility is in-process via the
public manifest/bundle. export is always produced from the C6 public
projection, never the raw snapshot/working tree.
`;

/** A command handler: sync or async, returns stdout text. */
type Handler = (argv: string[]) => string | Promise<string>;

/** Command table in documented order. */
const COMMANDS: ReadonlyArray<readonly [string, Handler]> = [
  ["init", cmdInit],
  ["status", cmdStatus],
  ["snapshot create", cmdSnapshotCreate],
  ["snapshot show", cmdSnapshotShow],
  ["snapshot list", cmdSnapshotList],
  ["bookmark list", cmdBookmarkList],
  ["bookmark set", cmdBookmarkSet],
  ["tag create", cmdTagCreate],
  ["tag list", cmdTagList],
  ["restore", cmdRestore],
  ["export", cmdExport],
  ["publish", cmdPublish],
  ["publish-check", cmdPublishCheck],
  ["unpublish", cmdUnpublish],
];

/** The bare command names (first token) for the usage error. */
const COMMAND_NAMES: readonly string[] = COMMANDS.map(([name]) => name);

/** Resolve a handler by matching the longest command prefix in `argv`. */
function resolveHandler(
  argv: string[],
): { handler: Handler; rest: string[] } | null {
  // Try two-token commands first (e.g. `snapshot create`), then one-token.
  if (argv.length >= 2) {
    const two = `${argv[0]} ${argv[1]}`;
    for (const [name, handler] of COMMANDS) {
      if (name === two) {
        return { handler, rest: argv.slice(2) };
      }
    }
  }
  if (argv.length >= 1) {
    const one = argv[0];
    for (const [name, handler] of COMMANDS) {
      if (name === one) {
        return { handler, rest: argv.slice(1) };
      }
    }
  }
  return null;
}

async function main(argv: string[]): Promise<number> {
  const [first] = argv;
  if (first === "--help" || first === "-h" || first === undefined) {
    process.stdout.write(HELP);
    return 0;
  }
  if (first === "--version" || first === "-v") {
    process.stdout.write(`${version}\n`);
    return 0;
  }

  // Global `--root <dir>` flag: select the durable CLI state root (defaults to
  // `.gtw` in the current working directory). Removed from argv before command
  // resolution so handlers never see it. `init`/`requireSession` use the
  // durable `FsStore`-backed session at this root; `requireSession` errors if
  // no session was initialized there, so a stray `gtw <cmd>` in a fresh cwd
  // does not silently create state.
  let rest = argv;
  let root = ".gtw";
  const rootIdx = rest.indexOf("--root");
  if (rootIdx !== -1) {
    const v = rest[rootIdx + 1];
    if (v === undefined) {
      process.stderr.write("gtw: missing value for --root\n");
      return 1;
    }
    root = v;
    rest = [...rest.slice(0, rootIdx), ...rest.slice(rootIdx + 2)];
  }
  setSessionRoot(root);

  const resolved = resolveHandler(rest);
  if (resolved === null) {
    process.stderr.write(
      `gtw: unknown command: ${rest.join(" ")}\n`,
    );
    process.stderr.write(
      `Run 'gtw --help' for usage. Commands: ${COMMAND_NAMES.join(", ")}\n`,
    );
    return 1;
  }

  try {
    const out = await resolved.handler(resolved.rest);
    // `cmdExport` bundle mode writes the artifact directly to stdout and
    // returns "" so the dispatcher does not append anything to the bytes.
    if (out.length > 0) process.stdout.write(out);
    return 0;
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(`gtw: ${err.message}\n`);
      return err.exitCode;
    }
    // Unexpected errors: print the message and surface a non-zero exit.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`gtw: error: ${msg}\n`);
    return 1;
  }
}

// `init` is the only command that may run before a session exists; all others
// require one. The handlers enforce this via `requireSession`. The smoke test
// and `--help`/`--version` must work without a session, so we do not create
// one eagerly here. `getSession` is re-exported for tests that inspect state.
void getSession;

const code = await main(process.argv.slice(2));
process.exit(code);
