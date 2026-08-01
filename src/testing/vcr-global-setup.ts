import { closeVcr } from "./vcr";

// Vitest globalSetup: the exported teardown runs after all tests but before Vite
// tears down its server, so closing the VCR agent here (flush cassette, stop the
// recorder timer, close real sockets) prevents the record-run hang.
export function setup(): void {}

export async function teardown(): Promise<void> {
  await closeVcr();
}
