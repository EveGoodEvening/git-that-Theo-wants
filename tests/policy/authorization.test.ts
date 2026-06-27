// C6 authorization check tests: read / checkout / publish / export.

import { describe, expect, it } from "bun:test";
import {
  authorize,
  canCheckout,
  canPublish,
  canRead,
  exportDecision,
  roleFor,
} from "../../src/policy/authorization.ts";
import { Denied } from "../../src/policy/visibility.ts";
import { asActorId } from "../../src/core/ids.ts";

const OWNER = asActorId("owner-actor");
const PEER = asActorId("peer-actor");
const ownerCtx = { actor: OWNER, ownerId: OWNER };
const peerCtx = { actor: PEER, ownerId: OWNER };

describe("C6 authorization role resolution", () => {
  it("roleFor: owner context -> owner, peer context -> peer", () => {
    expect(roleFor(ownerCtx)).toBe("owner");
    expect(roleFor(peerCtx)).toBe("peer");
  });
});

describe("C6 canRead", () => {
  it("public: owner and peer both read", () => {
    expect(canRead("public", ownerCtx)).toBe(true);
    expect(canRead("public", peerCtx)).toBe(true);
  });
  it("private/embargoed/local-only: owner reads, peer denied", () => {
    for (const s of ["private", "embargoed", "local-only"] as const) {
      expect(canRead(s, ownerCtx)).toBe(true);
      expect(canRead(s, peerCtx)).toBe(false);
    }
  });
});

describe("C6 canCheckout", () => {
  it("public: owner and peer both checkout", () => {
    expect(canCheckout("public", ownerCtx)).toBe(true);
    expect(canCheckout("public", peerCtx)).toBe(true);
  });
  it("non-public: owner checkout, peer denied", () => {
    for (const s of ["private", "embargoed", "local-only"] as const) {
      expect(canCheckout(s, ownerCtx)).toBe(true);
      expect(canCheckout(s, peerCtx)).toBe(false);
    }
  });
});

describe("C6 canPublish", () => {
  it("private/embargoed: owner can publish, peer cannot", () => {
    expect(canPublish("private", ownerCtx)).toBe(true);
    expect(canPublish("private", peerCtx)).toBe(false);
    expect(canPublish("embargoed", ownerCtx)).toBe(true);
    expect(canPublish("embargoed", peerCtx)).toBe(false);
  });
  it("public: nobody publishes (no transition)", () => {
    expect(canPublish("public", ownerCtx)).toBe(false);
    expect(canPublish("public", peerCtx)).toBe(false);
  });
  it("local-only: never publishable", () => {
    expect(canPublish("local-only", ownerCtx)).toBe(false);
    expect(canPublish("local-only", peerCtx)).toBe(false);
  });
});

describe("C6 exportDecision", () => {
  it("public -> include", () => {
    expect(exportDecision("public", ownerCtx)).toBe("include");
    expect(exportDecision("public", peerCtx)).toBe("include");
  });
  it("private/embargoed -> omit", () => {
    expect(exportDecision("private", ownerCtx)).toBe("omit");
    expect(exportDecision("embargoed", ownerCtx)).toBe("omit");
  });
  it("local-only -> Denied (explicit rejection, not silent omit)", () => {
    expect(() => exportDecision("local-only", ownerCtx)).toThrow(Denied);
    expect(() => exportDecision("local-only", peerCtx)).toThrow(Denied);
  });
});

describe("C6 authorize (typed throw on deny)", () => {
  it("allow returns 'allow'", () => {
    expect(authorize("public", "read", peerCtx)).toBe("allow");
  });
  it("omit returns 'omit'", () => {
    expect(authorize("private", "export", ownerCtx)).toBe("omit");
  });
  it("deny throws Denied", () => {
    expect(() => authorize("private", "read", peerCtx)).toThrow(Denied);
    expect(() => authorize("local-only", "publish", ownerCtx)).toThrow(Denied);
  });
});
