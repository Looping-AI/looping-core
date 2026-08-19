import { describe, it, expect } from "vitest";
import { jwksUrl } from "@loopingai/a2a-protocol";
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
   * A Worker answers on its custom domain, its `workers.dev` name and every
   * preview URL. Nothing is pinned: the last request wins, so an instance that
   * served both is signing as whichever origin it was actually reached on.
   */
  it("follows the origin of the most recent turn", () => {
    const origin = new SelfOrigin();
    origin.note(jwksUrl("https://agent.example.com"));
    origin.note(jwksUrl("https://preview-7.agent.workers.dev"));

    expect(origin.peek()).toBe("https://preview-7.agent.workers.dev");
  });

  /**
   * `note` runs at the top of a turn, so it must never be the thing that fails
   * one. An unusable value leaves the last good origin in place rather than
   * clearing it or throwing.
   */
  it("ignores anything it cannot read an origin from", () => {
    const origin = new SelfOrigin();
    origin.note(jwksUrl(AGENT_ORIGIN));

    origin.note(undefined);
    origin.note("");
    origin.note("/.well-known/jwks.json");
    origin.note("data:application/json,{}");

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
