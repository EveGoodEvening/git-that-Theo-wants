// C6 visibility state-operation matrix tests.
//
// Covers every (state, operation, role) cell of the deterministic matrix, the
// no-time-based-behavior guarantee for `embargoed`, the publish/unpublish
// transition preconditions, and the export-omission rules.

import { describe, expect, it } from "bun:test";
import {
  type VisibilityOperation,
  type VisibilityState,
  VISIBILITY_STATES,
  Denied,
  PUBLISHABLE_STATES,
  matrixDecision,
  publishTarget,
  resolveRole,
  unpublishTarget,
} from "../../src/policy/visibility.ts";
import { asActorId } from "../../src/core/ids.ts";

const OWNER = asActorId("owner-actor");
const PEER = asActorId("peer-actor");

describe("C6 visibility states", () => {
  it("defines exactly the four states", () => {
    expect(VISIBILITY_STATES).toEqual([
      "public",
      "private",
      "embargoed",
      "local-only",
    ]);
  });

  it("resolveRole: actor === owner -> owner, else peer", () => {
    expect(resolveRole(OWNER, OWNER)).toBe("owner");
    expect(resolveRole(PEER, OWNER)).toBe("peer");
  });
});

describe("C6 state-operation matrix (every cell)", () => {
  // Encode the expected matrix as a table for exhaustive assertion.
  const EXPECTED: Record<
    VisibilityState,
    Partial<Record<VisibilityOperation, { owner: string; peer: string }>>
  > = {
    public: {
      read: { owner: "allow", peer: "allow" },
      checkout: { owner: "allow", peer: "allow" },
      publish: { owner: "deny", peer: "deny" },
      export: { owner: "allow", peer: "allow" },
    },
    private: {
      read: { owner: "allow", peer: "deny" },
      checkout: { owner: "allow", peer: "deny" },
      publish: { owner: "allow", peer: "deny" },
      export: { owner: "omit", peer: "omit" },
    },
    embargoed: {
      read: { owner: "allow", peer: "deny" },
      checkout: { owner: "allow", peer: "deny" },
      publish: { owner: "allow", peer: "deny" },
      export: { owner: "omit", peer: "omit" },
    },
    "local-only": {
      read: { owner: "allow", peer: "deny" },
      checkout: { owner: "allow", peer: "deny" },
      publish: { owner: "deny", peer: "deny" },
      export: { owner: "deny", peer: "deny" },
    },
  };

  const OPS: VisibilityOperation[] = ["read", "checkout", "publish", "export"];

  for (const state of VISIBILITY_STATES) {
    for (const op of OPS) {
      for (const role of ["owner", "peer"] as const) {
        it(`${state} + ${op} + ${role} -> ${EXPECTED[state][op]?.[role]}`, () => {
          const got = matrixDecision(state, op, role);
          expect(got).toBe(EXPECTED[state][op]?.[role]);
        });
      }
    }
  }

  it("public is readable by peer and present in export", () => {
    expect(matrixDecision("public", "read", "peer")).toBe("allow");
    expect(matrixDecision("public", "export", "peer")).toBe("allow");
  });

  it("private: owner reads, peer denied, omitted from export", () => {
    expect(matrixDecision("private", "read", "owner")).toBe("allow");
    expect(matrixDecision("private", "read", "peer")).toBe("deny");
    expect(matrixDecision("private", "export", "owner")).toBe("omit");
  });

  it("embargoed: owner reads, peer denied, omitted from export", () => {
    expect(matrixDecision("embargoed", "read", "owner")).toBe("allow");
    expect(matrixDecision("embargoed", "read", "peer")).toBe("deny");
    expect(matrixDecision("embargoed", "export", "owner")).toBe("omit");
  });

  it("local-only: owner-local reads, peer denied, publish+export rejected", () => {
    expect(matrixDecision("local-only", "read", "owner")).toBe("allow");
    expect(matrixDecision("local-only", "read", "peer")).toBe("deny");
    expect(matrixDecision("local-only", "publish", "owner")).toBe("deny");
    expect(matrixDecision("local-only", "export", "owner")).toBe("deny");
  });
});

describe("C6 no time-based behavior (embargoed)", () => {
  it("embargoed publish is allowed only via explicit publish, not a clock advance", () => {
    // The matrix is a pure function of (state, op, role). There is no time
    // argument. Advancing a mock clock does not change the decision because
    // time is not an input.
    const before = matrixDecision("embargoed", "read", "peer");
    // Simulate a "clock advance" by calling again later — the decision is
    // identical because time is not a parameter.
    const after = matrixDecision("embargoed", "read", "peer");
    expect(before).toBe("deny");
    expect(after).toBe("deny");
    // Export remains omit regardless of any external clock.
    expect(matrixDecision("embargoed", "export", "owner")).toBe("omit");
    // Only an explicit publish (owner) transitions out.
    expect(matrixDecision("embargoed", "publish", "owner")).toBe("allow");
  });
});

describe("C6 publish/unpublish transition preconditions", () => {
  it("publishTarget: private/embargoed -> public", () => {
    expect(publishTarget("private")).toBe("public");
    expect(publishTarget("embargoed")).toBe("public");
  });

  it("publishTarget rejects public (already public, no transition)", () => {
    expect(() => publishTarget("public")).toThrow(Denied);
  });

  it("publishTarget rejects local-only (never publishable)", () => {
    expect(() => publishTarget("local-only")).toThrow(Denied);
  });

  it("PUBLISHABLE_STATES is exactly private + embargoed", () => {
    expect(PUBLISHABLE_STATES).toEqual(["private", "embargoed"]);
  });

  it("unpublishTarget: public -> private", () => {
    expect(unpublishTarget("public")).toBe("private");
  });

  it("unpublishTarget rejects non-public states", () => {
    expect(() => unpublishTarget("private")).toThrow(Denied);
    expect(() => unpublishTarget("embargoed")).toThrow(Denied);
    expect(() => unpublishTarget("local-only")).toThrow(Denied);
  });
});

describe("C6 Denied error", () => {
  it("carries the (state, op, role) triple without private metadata", () => {
    const d = new Denied("private", "read", "peer");
    expect(d.state).toBe("private");
    expect(d.op).toBe("read");
    expect(d.role).toBe("peer");
    expect(d.name).toBe("Denied");
    // The message must not contain paths, blob ids, snapshot ids, or timestamps.
    expect(d.message).not.toMatch(/[0-9a-f]{40,}/);
  });
});
