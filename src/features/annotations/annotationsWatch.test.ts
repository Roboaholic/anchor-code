import { describe, expect, it } from "vitest";
import { isAnnotationsChange } from "./annotationsStore";

describe("isAnnotationsChange", () => {
  it("matches writes under <repo>/.anchor-code", () => {
    expect(isAnnotationsChange("/r/repo", "/r/repo/.anchor-code/sessions/a.yaml")).toBe(true);
    expect(isAnnotationsChange("C:\\r\\repo", "C:\\r\\repo\\.anchor-code\\x.yaml")).toBe(true);
    expect(isAnnotationsChange("/r/repo/", "/r/repo/.anchor-code")).toBe(true);
  });
  it("ignores other paths", () => {
    expect(isAnnotationsChange("/r/repo", "/r/repo/src/a.ts")).toBe(false);
    expect(isAnnotationsChange("/r/repo", "/r/repo2/.anchor-code/a.yaml")).toBe(false);
  });
});
