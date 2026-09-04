import { describe, it, expect } from "vitest";
import { jwksUrl } from "@dynamicagents/g2a-protocol";
import { SelfOrigin } from "./self-origin.js";
import { AGENT_ORIGIN } from "../testing/fixtures.js";

describe("SelfOrigin", () => {
  /**
   * The value core actually delivers is a `jku`, and what a caller token needs
   * is the origin under it — the same origin, by construction, because
   * `signCallerToken` derives its own `jku` back from `iss`.
   */
  it("keeps the origin of the jku a turn carries", () => {
    const origin = new SelfOrigin();
    origin.note(jwksUrl(AGENT_ORIGIN));

    expect(origin.peek()).toBe(AGENT_ORIGIN);
    expect(origin.require()).toBe(AGENT_ORIGIN);
  });

  /**
   * A bare origin, not whatever URL carried it. `signCallerToken` normalizes
   * `iss` again anyway; everything else — an identity key, a log line, a URL an
   * agent builds — reads this verbatim.
   */
  it("keeps only the origin, never a path or a trailing slash", () => {
    const origin = new SelfOrigin();
    origin.note(`${AGENT_ORIGIN}/a2a/`);

    expect(origin.peek()).toBe(AGENT_ORIGIN);
  });

  /**
   * The pin is what makes the value safe to read: turns run concurrently in one
   * Durable Object, and a credential thunk reads this several frames below the
   * turn that set it. Immutable after the first write, no turn can sign as
   * another turn's origin — so a later, different origin is ignored.
   */
  it("pins the first origin and ignores a later one", () => {
    const origin = new SelfOrigin();
    origin.note(jwksUrl("https://agent.example.com"));
    origin.note(jwksUrl("https://other.agent.workers.dev"));

    expect(origin.peek()).toBe("https://agent.example.com");
  });

  /**
   * Unusable first, good second — the order that matters. `note` runs at the top
   * of a turn and must never fail one, but it must also never let a value it
   * could not read an origin from occupy the pin, which would be unrecoverable
   * for the life of the isolate.
   */
  it("does not let an unusable value take the pin", () => {
    const origin = new SelfOrigin();

    origin.note(undefined);
    origin.note("");
    origin.note("/.well-known/jwks.json");
    origin.note("data:application/json,{}");
    expect(origin.peek()).toBeUndefined();

    origin.note(jwksUrl(AGENT_ORIGIN));
    expect(origin.peek()).toBe(AGENT_ORIGIN);
  });

  /**
   * The mistake this always is, is timing — `onStart`, a constructor or a cron
   * callback, all of which run before any request has said what this deployment
   * is called. So the throw says so, rather than letting a token be signed with
   * `undefined` as its issuer.
   */
  it("throws naming the timing when nothing has carried an origin", () => {
    const origin = new SelfOrigin();

    expect(origin.peek()).toBeUndefined();
    expect(() => origin.require()).toThrow(/not known on this instance/);
  });
});
