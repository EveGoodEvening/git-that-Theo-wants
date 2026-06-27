// C5 policy layer: bind per-object secret access to the C1 signed ACL graph.
//
// `decryptSecret` (the in-memory blob primitive) only checks the key/policy
// binding (`policyId`) — it does not authorize access to a specific stored
// object. Without an ACL check, a caller with the matching key could decrypt
// any blob that key encrypted. This module closes that gap: a read grant is a
// C1 `SignedAclNode` whose `record.object` is the secret object id and whose
// `permissions` include `'read'`. The grant is signed with a local HMAC key
// (C1 signature stub) and persisted in the store's ACL metadata graph.
//
// `createReadGrant` mints and persists such a grant; `verifyReadGrant` fetches
// a node from the store, verifies its signature, and checks the object +
// permission bindings. Both store-backed decrypt paths in `secret.ts`
// (`getAndDecryptSecret` and `decryptSecretFromStore`) consume a verified
// grant to authorize decryption — neither accepts arbitrary caller-supplied
// `policyId` as authority.
//
// This is a non-production stub (plan §2, C5 Blocker/Deferred): real
// asymmetric signing / KMS / revocation are deferred. The stub is sufficient
// to demonstrate that access policy is bound to signed/authenticated graph
// state, not to user-editable config.
import { type AclNodeId, type ActorId, type LocalKey, type SignedAclNode, createSignedAclNode, verifyAclRecord } from "../core/acl.ts";
import { type Hash } from "../core/ids.ts";
import type { Store } from "../store/store.ts";

/**
 * Mint a signed ACL read grant for `objectId` to `subject` and persist it in
 * `store`'s ACL metadata graph. The grant is a `SignedAclNode` with
 * `permissions = { 'read' }` and `record.object = objectId`, signed with
 * `aclKey` (C1 HMAC stub). Returns the signed node (with its `AclNodeId`).
 *
 * The caller is responsible for having already persisted the secret object
 * whose id is `objectId`; this helper only creates and stores the grant.
 */
export async function createReadGrant(
  store: Store,
  objectId: Hash,
  subject: ActorId,
  aclKey: LocalKey,
): Promise<SignedAclNode> {
  const node = await createSignedAclNode(
    {
      subject,
      object: objectId,
      permissions: new Set<"read" | "write" | "publish">(["read"]),
    },
    aclKey,
  );
  store.putAcl(node);
  return node;
}

/**
 * Fetch a signed ACL node from `store` by `grantId` and verify it is a valid
 * read grant for `objectId`: the signature must verify under `aclKey`,
 * `record.object` must equal `objectId`, and `permissions` must include
 * `'read'`. Returns the verified node, or `undefined` if the node is missing,
 * the signature is invalid, the object binding is wrong, or the grant lacks
 * read permission.
 *
 * A missing node (`Store.getAcl` throws `NotFound`) is reported as
 * `undefined` rather than re-thrown, so callers can distinguish "no grant"
 * from a store error. Use `decryptSecretFromStore` for the typed `Denied`
 * path that consumes this verification.
 */
export async function verifyReadGrant(
  store: Store,
  grantId: AclNodeId,
  objectId: Hash,
  aclKey: LocalKey,
): Promise<SignedAclNode | undefined> {
  let node: SignedAclNode;
  try {
    node = store.getAcl(grantId);
  } catch {
    return undefined;
  }
  const ok = await verifyAclRecord(node.record, node.signature, aclKey);
  if (!ok) return undefined;
  if (node.record.object !== objectId) return undefined;
  if (!node.record.permissions.has("read")) return undefined;
  return node;
}
