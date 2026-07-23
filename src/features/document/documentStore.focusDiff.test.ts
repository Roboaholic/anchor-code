import { beforeEach, describe, expect, it } from "vitest";
import { useDocumentStore } from "./documentStore";

describe("openDiff focus mode", () => {
  beforeEach(() => {
    useDocumentStore.setState({
      openItems: [{ id: "welcome", kind: "welcome", title: "Welcome" }],
      activeId: "welcome",
    });
  });

  it("opens single-file diff without sidebar", () => {
    useDocumentStore.getState().openDiff({
      repoRoot: "/repo",
      base: "HEAD",
      head: "worktree",
      title: "a.ts · M",
      files: [{ path: "src/a.ts", status: "M" }],
      activeFilePath: "src/a.ts",
      hideFileList: true,
    });
    const item = useDocumentStore.getState().openItems.find((i) => i.kind === "diff");
    expect(item).toBeDefined();
    if (!item || item.kind !== "diff") throw new Error("missing");
    expect(item.hideFileList).toBe(true);
    expect(item.activeFilePath).toBe("src/a.ts");
    expect(item.id).toContain("src/a.ts");
  });

  it("keeps multi-file compare id without path suffix", () => {
    useDocumentStore.getState().openDiff({
      repoRoot: "/repo",
      base: "aaa",
      head: "bbb",
      title: "aaa → bbb",
      files: [
        { path: "a.ts", status: "M" },
        { path: "b.ts", status: "A" },
      ],
    });
    const item = useDocumentStore.getState().openItems.find((i) => i.kind === "diff");
    expect(item?.id).toBe("diff:/repo:aaa:bbb");
    if (item?.kind === "diff") expect(item.hideFileList).toBe(false);
  });
});
