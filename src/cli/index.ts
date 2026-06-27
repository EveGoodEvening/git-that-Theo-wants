#!/usr/bin/env bun
// gtw CLI entrypoint. C0 ships only a `--help`/`-h` stub that prints the
// version and a one-line usage banner, then exits 0. Real command dispatch
// (init/status/snapshot/bookmark/tag/restore/export/publish/...) is C9.

import { version } from "../index.ts";

const HELP = `gtw ${version}
Git that Theo wants — prototype source control.

Usage:
  gtw --help, -h        Show this help and exit
  gtw --version, -v     Print version and exit

Commands are implemented in a later chunk.
`;

function main(argv: string[]): number {
  const [first] = argv;
  if (first === "--help" || first === "-h" || first === undefined) {
    process.stdout.write(HELP);
    return 0;
  }
  if (first === "--version" || first === "-v") {
    process.stdout.write(`${version}\n`);
    return 0;
  }
  process.stderr.write(`gtw: unknown command or flag: ${first}\n`);
  process.stderr.write(`Run 'gtw --help' for usage.\n`);
  return 1;
}

const code = main(process.argv.slice(2));
process.exit(code);
