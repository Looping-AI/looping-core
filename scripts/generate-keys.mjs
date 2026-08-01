#!/usr/bin/env node
/**
 * Generate the Ed25519 keypair an agent signs its AgentCard with.
 *
 * The private half becomes the `A2A_SIGNING_KEY` secret; the public half is
 * served at the agent's JWKS path and pinned by the gateway on first
 * registration (Trust-On-First-Use). No secret is shared in either direction —
 * see `src/a2a/verify.ts` for the other half of the contract.
 *
 *   node scripts/generate-keys.mjs              # print both halves
 *   node scripts/generate-keys.mjs --kid my-key # choose the key id
 *
 * The `kid` is required, not decorative: it goes in the JWS protected header and
 * is what a gateway pins, so `parsePrivateJwk` refuses a key without one. Rotate
 * by generating a new key with a *new* kid and serving both public keys until
 * every gateway has re-fetched.
 */
import { generateKeyPair, exportJWK } from "jose";

const args = process.argv.slice(2);
const kidFlag = args.indexOf("--kid");
const kid =
  kidFlag !== -1 && args[kidFlag + 1]
    ? args[kidFlag + 1]
    : `a2a-${new Date().toISOString().slice(0, 10)}`;

// `extractable` is required to export the private half at all.
const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
  crv: "Ed25519",
  extractable: true
});

const priv = { ...(await exportJWK(privateKey)), kid };
const pub = { ...(await exportJWK(publicKey)), kid, use: "sig", alg: "EdDSA" };

console.log("A2A_SIGNING_KEY (private — set as a secret, never commit):\n");
console.log(JSON.stringify(priv));
console.log(
  "\nPublic JWKS (served at the card's `jku`, derived at runtime):\n"
);
console.log(JSON.stringify({ keys: [pub] }, null, 2));
console.log(`
Next:

  # local
  echo 'A2A_SIGNING_KEY=<the private JSON above>' >> .dev.vars

  # deployed
  npx wrangler secret put A2A_SIGNING_KEY

The public half is not configured anywhere — the Worker derives it from the
private key and serves it at the JWKS route.
`);
