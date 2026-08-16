import { closeVcr } from "./vcr.js";

/**
 * Vitest `globalSetup`: the exported teardown runs after all tests but before
 * Vite tears down its server, so it is the last point at which a cassette can
 * still be written.
 *
 * Belt and braces rather than load-bearing — each cassette is already flushed
 * when its test releases it, so a run that ends normally has nothing left to do
 * here, and a run that dies mid-test keeps everything recorded up to that point.
 * The recorder holds no sockets and no timers, so nothing here has to close.
 */
export function setup(): void {}

export async function teardown(): Promise<void> {
  await closeVcr();
}
