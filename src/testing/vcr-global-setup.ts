import { closeVcr } from "./vcr.js";

/**
 * Vitest `globalSetup`: the exported teardown runs after all tests but before
 * Vite tears down its server, so it is the last point at which a cassette can
 * still be written.
 *
 * Belt and braces rather than load-bearing — each cassette is already flushed
 * when its test releases it, so a run that ends normally has nothing left to do
 * here, and a run that dies mid-test keeps everything recorded up to that point.
 * (Under the old undici recorder this step was mandatory: it held real sockets
 * and a self-refreshing auto-flush timer open, and a `RECORD=1` run hung on
 * "close timed out" without it. Neither exists now.)
 */
export function setup(): void {}

export async function teardown(): Promise<void> {
  await closeVcr();
}
