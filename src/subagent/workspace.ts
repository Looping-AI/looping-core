/**
 * The narrow file-store surface the resumable runner and its tool families use.
 *
 * Core declares the *interface* and the caps; it does not declare a backend.
 * The predecessor backed this with `@cloudflare/shell`, which is experimental
 * ("expect breaking changes") — so an agent that never delegates file work should
 * not carry it. `@dynamicagents/plugins/workspace` supplies the shell-backed
 * implementation and the model-facing `ws_read`/`ws_write`/`ws_list` tools; core
 * only needs to be able to *name* a workspace, because {@link ToolFamilyContext}
 * hands one to every tool family.
 */
export interface WorkspaceHandle {
  /** File content, or null if the file does not exist. */
  read(path: string): Promise<string | null>;
  /** Write (create or overwrite) a text file. Parent directories are created. */
  write(path: string, content: string): Promise<void>;
  /** Whether a file or directory exists at the path. */
  exists(path: string): Promise<boolean>;
  /** Delete a file. Returns whether a file was removed. */
  remove(path: string): Promise<boolean>;
  /** Immediate entries under `dir` (default root): their path and byte size. */
  list(dir?: string): Promise<WorkspaceEntry[]>;
  /** Parse a JSON file, or null if it does not exist. Throws on malformed JSON. */
  readJson<T>(path: string): Promise<T | null>;
  /** Serialize a value to a JSON file (pretty-printed). */
  writeJson(path: string, value: unknown): Promise<void>;
}

export interface WorkspaceEntry {
  path: string;
  type: "file" | "directory" | "symlink";
  size: number;
}

/**
 * The backend surface {@link makeWorkspaceHandle} needs, declared **structurally**
 * rather than as `Pick<Workspace, …>`.
 *
 * That is the whole reason core can stay free of `@cloudflare/shell`: a shell
 * `Workspace` satisfies this by construction, and so does a plain in-memory fake
 * in a test, without either being named here.
 */
export interface WorkspaceBacking {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  deleteFile(path: string): Promise<boolean>;
  readDir(dir?: string): Promise<readonly WorkspaceEntry[]>;
  getWorkspaceInfo(): Promise<{ fileCount: number }>;
}

/**
 * An in-memory {@link WorkspaceBacking} — the fallback when no installed plugin
 * declares one.
 *
 * Deliberately **not durable**, and that is the honest behaviour rather than a
 * shortcut: a durable stand-in would have to invent a storage layout that a real
 * backend would then have to migrate away from. An agent that delegates file
 * work installs a backend; one that does not never writes a file, and pays
 * nothing for the option. What this buys is that `createAgentRuntime` composes
 * without a workspace plugin at all, so `SubagentRuntime.workspaceBacking` can
 * stay required and a host never writes a null check.
 *
 * Scoped per call, so each execution gets its own map, exactly as a facet's own
 * SQLite would give it its own tables. Contents are lost on isolate eviction —
 * the resumable runner treats a lost workspace as a resumable state everywhere
 * it matters.
 *
 * Signature matches {@link AgentPlugin.workspaceBacking}; both arguments are
 * ignored.
 */
export function memoryWorkspaceBacking(
  _sql?: SqlStorage,
  _name?: () => string | undefined
): WorkspaceBacking {
  const files = new Map<string, string>();

  /** Immediate children of `dir`, as `readDir` reports them. */
  const entriesUnder = (dir: string): WorkspaceEntry[] => {
    const prefix = dir === "" ? "" : `${dir}/`;
    const seen = new Map<string, WorkspaceEntry>();
    for (const [path, content] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (rest === "") continue;
      const slash = rest.indexOf("/");
      if (slash === -1) {
        seen.set(path, {
          path,
          type: "file",
          size: new TextEncoder().encode(content).length
        });
      } else {
        // A directory exists only because something under it does, so report it
        // once and say nothing about its size.
        const child = `${prefix}${rest.slice(0, slash)}`;
        seen.set(child, { path: child, type: "directory", size: 0 });
      }
    }
    return [...seen.values()];
  };

  return {
    readFile: async (path) => files.get(normalize(path)) ?? null,
    writeFile: async (path, content) => {
      files.set(normalize(path), content);
    },
    // Directories are implied by their contents, so a path with anything under
    // it exists even though nothing ever created it.
    exists: async (path) => {
      const key = normalize(path);
      return files.has(key) || entriesUnder(key).length > 0;
    },
    deleteFile: async (path) => files.delete(normalize(path)),
    readDir: async (dir) => entriesUnder(normalize(dir ?? "")),
    getWorkspaceInfo: async () => ({ fileCount: files.size })
  };
}

/** Strip the leading/trailing slashes that would otherwise key two paths apart. */
function normalize(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

/** Per-file byte ceiling — safely under the 2 MB Durable Object SQLite row limit. */
export const WORKSPACE_MAX_FILE_BYTES = 512 * 1024;
/** Max number of files in one workspace — a cheap guard against runaway writes. */
export const WORKSPACE_MAX_FILES = 200;

export class WorkspaceLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceLimitError";
  }
}

/**
 * Build a {@link WorkspaceHandle} over a shell workspace (or a test fake),
 * enforcing the per-file and file-count caps. The caps degrade a misbehaving
 * recipe to an explicit error rather than letting it exceed the DO row limit or
 * fill storage.
 */
export function makeWorkspaceHandle(ws: WorkspaceBacking): WorkspaceHandle {
  const byteLength = (s: string): number => new TextEncoder().encode(s).length;

  return {
    read: (path) => ws.readFile(path),

    async write(path, content) {
      const bytes = byteLength(content);
      if (bytes > WORKSPACE_MAX_FILE_BYTES) {
        throw new WorkspaceLimitError(
          `file "${path}" is ${bytes} bytes, over the ${WORKSPACE_MAX_FILE_BYTES}-byte limit`
        );
      }
      // The cap bounds how many files exist, so it may only refuse a write that
      // *creates* one. `exists` is the wrong question: it is true for a
      // directory too (filesystem semantics, which every real backing has), so
      // at the cap a write to `notes` — with `notes/a.txt` present — read as an
      // overwrite and added a 201st file. `readFile` returning null is the only
      // honest test for "there is no file here", and it runs solely when the
      // workspace is already full, so the ordinary write still costs one call.
      const { fileCount } = await ws.getWorkspaceInfo();
      if (
        fileCount >= WORKSPACE_MAX_FILES &&
        (await ws.readFile(path)) === null
      ) {
        throw new WorkspaceLimitError(
          `workspace already holds ${fileCount} files (max ${WORKSPACE_MAX_FILES})`
        );
      }
      await ws.writeFile(path, content);
    },

    exists: (path) => ws.exists(path),

    remove: (path) => ws.deleteFile(path),

    async list(dir) {
      const entries = await ws.readDir(dir);
      return entries.map((e) => ({
        path: e.path,
        type: e.type,
        size: e.size
      }));
    },

    async readJson<T>(path: string): Promise<T | null> {
      const raw = await ws.readFile(path);
      return raw === null ? null : (JSON.parse(raw) as T);
    },

    async writeJson(path, value) {
      await this.write(path, JSON.stringify(value, null, 2));
    }
  };
}
