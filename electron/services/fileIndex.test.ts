import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalHostSession } from "../host/localHost.js";
import { findWorkspaceFiles } from "./fileIndex.js";

describe("findWorkspaceFiles", () => {
  let tmp: string;
  let host: LocalHostSession;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "anchor-find-"));
    host = new LocalHostSession("find-test");
    host.workspaceRoot = tmp;
  });

  afterEach(async () => {
    await host.dispose();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("walks nested files and skips node_modules / .git", async () => {
    await fs.mkdir(path.join(tmp, "src", "nested"), { recursive: true });
    await fs.mkdir(path.join(tmp, "node_modules", "pkg"), { recursive: true });
    await fs.mkdir(path.join(tmp, ".git", "objects"), { recursive: true });
    await fs.writeFile(path.join(tmp, "README.md"), "hi\n");
    await fs.writeFile(path.join(tmp, "src", "nested", "a.ts"), "export {};\n");
    await fs.writeFile(path.join(tmp, "node_modules", "pkg", "index.js"), "1\n");
    await fs.writeFile(path.join(tmp, ".git", "HEAD"), "ref: refs/heads/main\n");

    const result = await findWorkspaceFiles(host, tmp, { maxFiles: 100 });

    expect(result.source).toBe("walk");
    expect(result.truncated).toBe(false);
    expect(result.files).toContain("README.md");
    expect(result.files).toContain("src/nested/a.ts");
    expect(result.files.some((f) => f.includes("node_modules"))).toBe(false);
    expect(result.files.some((f) => f.includes(".git"))).toBe(false);
  });

  it("honors maxFiles and sets truncated", async () => {
    await fs.mkdir(path.join(tmp, "many"), { recursive: true });
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(path.join(tmp, "many", `f${i}.txt`), `${i}\n`);
    }

    const result = await findWorkspaceFiles(host, tmp, { maxFiles: 2 });

    expect(result.source).toBe("walk");
    expect(result.files.length).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("prefers git ls-files when repo is available", async () => {
    execFileSync("git", ["init"], { cwd: tmp, stdio: "ignore" });
    // Avoid noisy identity prompts on CI sandboxes that require commit — ls-files works without commit.
    await fs.mkdir(path.join(tmp, "docs"), { recursive: true });
    await fs.writeFile(path.join(tmp, "docs", "DESIGN.md"), "# design\n");
    await fs.writeFile(path.join(tmp, "skip-me.log"), "x\n");
    await fs.writeFile(path.join(tmp, ".gitignore"), "*.log\n");
    execFileSync("git", ["add", "docs/DESIGN.md", ".gitignore"], {
      cwd: tmp,
      stdio: "ignore",
    });

    // Untracked but not ignored
    await fs.writeFile(path.join(tmp, "docs", "notes.md"), "n\n");

    const result = await findWorkspaceFiles(host, tmp);

    expect(result.source).toBe("git");
    expect(result.files).toContain("docs/DESIGN.md");
    expect(result.files).toContain("docs/notes.md");
    expect(result.files).toContain(".gitignore");
    // ignored by git
    expect(result.files).not.toContain("skip-me.log");
  });
});
