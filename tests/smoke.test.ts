// C0 smoke test: asserts `version` is defined and that the CLI `--help` stub
// exits 0 and prints the version. No business logic is exercised here.

import { describe, expect, it } from "bun:test";
import { version } from "../src/index.ts";
import { $ } from "bun";

describe("C0 bootstrap", () => {
  it("exports a defined version constant", () => {
    expect(typeof version).toBe("string");
    expect(version.length).toBeGreaterThan(0);
  });

  it("gtw --help exits 0 and prints the version", async () => {
    const result = await $`bun run src/cli/index.ts --help`.nothrow();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(version);
    expect(result.stdout.toString()).toContain("--help");
  });

  it("gtw -h exits 0 and prints the version", async () => {
    const result = await $`bun run src/cli/index.ts -h`.nothrow();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(version);
  });
});
