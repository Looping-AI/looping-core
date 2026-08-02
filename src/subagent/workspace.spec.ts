import { describe, it, expect } from "vitest";
import {
  makeWorkspaceHandle,
  memoryWorkspaceBacking,
  WorkspaceLimitError,
  WORKSPACE_MAX_FILE_BYTES,
  WORKSPACE_MAX_FILES
} from "./workspace.js";

/**
 * The handle is the seam that keeps `@cloudflare/shell` out of core: it enforces
 * the caps over a structurally-declared backing, so a shell `Workspace` and an
 * in-memory fake both satisfy it without either being named here. These specs
 * drive it through the fake — which is also core's fallback backend, so they
 * cover both at once.
 */

describe("makeWorkspaceHandle", () => {
  it("reads back what it writes, and returns null for a missing file", async () => {
    const ws = makeWorkspaceHandle(memoryWorkspaceBacking());
    expect(await ws.read("notes.md")).toBeNull();
    await ws.write("notes.md", "hello");
    expect(await ws.read("notes.md")).toBe("hello");
    expect(await ws.exists("notes.md")).toBe(true);
  });

  it("round-trips JSON via readJson/writeJson", async () => {
    const ws = makeWorkspaceHandle(memoryWorkspaceBacking());
    await ws.writeJson("state.json", { a: 1, b: ["x"] });
    expect(await ws.readJson("state.json")).toEqual({ a: 1, b: ["x"] });
    expect(await ws.readJson("missing.json")).toBeNull();
  });

  it("throws on malformed JSON rather than answering null", async () => {
    // null means "no file". Collapsing a corrupt file into the same answer would
    // make a resumable run silently restart from scratch instead of failing.
    const ws = makeWorkspaceHandle(memoryWorkspaceBacking());
    await ws.write("state.json", "{not json");
    await expect(ws.readJson("state.json")).rejects.toThrow();
  });

  it("lists files with sizes", async () => {
    const ws = makeWorkspaceHandle(memoryWorkspaceBacking());
    await ws.write("a.txt", "12345");
    expect(await ws.list()).toEqual([{ path: "a.txt", type: "file", size: 5 }]);
  });

  it("removes files", async () => {
    const ws = makeWorkspaceHandle(memoryWorkspaceBacking());
    await ws.write("a.txt", "x");
    expect(await ws.remove("a.txt")).toBe(true);
    expect(await ws.exists("a.txt")).toBe(false);
  });

  it("rejects a file over the per-file byte cap", async () => {
    // The cap exists to keep a row under the 2 MB Durable Object SQLite limit —
    // an explicit error beats a write that fails somewhere in the storage layer.
    const ws = makeWorkspaceHandle(memoryWorkspaceBacking());
    const tooBig = "a".repeat(WORKSPACE_MAX_FILE_BYTES + 1);
    await expect(ws.write("big.txt", tooBig)).rejects.toThrow(
      WorkspaceLimitError
    );
  });

  it("measures the cap in bytes, not characters", async () => {
    // `"…".length` is UTF-16 units; the row limit is bytes. A file of multi-byte
    // characters is under the cap by one measure and over it by the other.
    const ws = makeWorkspaceHandle(memoryWorkspaceBacking());
    const threeByteChars = "€".repeat(WORKSPACE_MAX_FILE_BYTES / 3 + 1);
    expect(threeByteChars.length).toBeLessThan(WORKSPACE_MAX_FILE_BYTES);
    await expect(ws.write("euro.txt", threeByteChars)).rejects.toThrow(
      WorkspaceLimitError
    );
  });

  it("rejects a new file once the file-count cap is reached", async () => {
    const ws = makeWorkspaceHandle(memoryWorkspaceBacking());
    for (let i = 0; i < WORKSPACE_MAX_FILES; i++) {
      await ws.write(`f${i}.txt`, "x");
    }
    await expect(ws.write("one-too-many.txt", "x")).rejects.toThrow(
      WorkspaceLimitError
    );
    // Overwriting an existing file is still allowed at the cap — the cap bounds
    // how many files exist, not how often they are written.
    await expect(ws.write("f0.txt", "y")).resolves.toBeUndefined();
  });
});

describe("memoryWorkspaceBacking", () => {
  /**
   * Core's fallback when no plugin supplies a backend. It only has to be correct
   * enough that an agent without a workspace plugin composes and runs.
   */

  it("gives each call its own store", async () => {
    // One per execution, exactly as a facet's own SQLite would be.
    const a = memoryWorkspaceBacking();
    const b = memoryWorkspaceBacking();
    await a.writeFile("shared.txt", "from a");
    expect(await b.readFile("shared.txt")).toBeNull();
  });

  it("reports directories implied by their contents", async () => {
    const ws = memoryWorkspaceBacking();
    await ws.writeFile("notes/day1.md", "one");
    await ws.writeFile("notes/day2.md", "two");
    await ws.writeFile("top.md", "three");

    // Nothing ever created `notes/`, but it exists because something is under it.
    expect(await ws.exists("notes")).toBe(true);
    expect(await ws.readDir()).toEqual([
      { path: "notes", type: "directory", size: 0 },
      { path: "top.md", type: "file", size: 5 }
    ]);
    expect(await ws.readDir("notes")).toEqual([
      { path: "notes/day1.md", type: "file", size: 3 },
      { path: "notes/day2.md", type: "file", size: 3 }
    ]);
  });

  it("treats a leading slash as the same path", async () => {
    const ws = memoryWorkspaceBacking();
    await ws.writeFile("/notes.md", "hello");
    expect(await ws.readFile("notes.md")).toBe("hello");
    expect(await ws.getWorkspaceInfo()).toEqual({ fileCount: 1 });
  });

  it("reports deletion of a file that was never there", async () => {
    const ws = memoryWorkspaceBacking();
    expect(await ws.deleteFile("gone.md")).toBe(false);
  });
});
