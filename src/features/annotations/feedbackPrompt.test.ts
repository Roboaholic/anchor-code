import { describe, expect, it } from "vitest";
import {
  agentAuthorFromProfile,
  buildFeedbackPrompt,
  countOpenFeedbackComments,
  feedbackTabTitle,
  isAnchorReviewInstalled,
} from "./feedbackPrompt";

describe("buildFeedbackPrompt", () => {
  it("includes yaml path, skill guidance, and goals", () => {
    const prompt = buildFeedbackPrompt({
      yamlPath: "C:/repo/.anchor-code/session_1.yaml",
    });
    expect(prompt).toContain("anchor-review skill");
    expect(prompt).toContain("C:/repo/.anchor-code/session_1.yaml");
    expect(prompt).toContain("need_modify");
    expect(prompt).toContain("Match the language of each human comment");
    expect(prompt).toContain("set author exactly to: agent");
    expect(prompt).not.toContain("Additional instructions");
  });

  it("includes export path, notes, and selected agent author", () => {
    const prompt = buildFeedbackPrompt({
      yamlPath: "/repo/.anchor-code/s.yaml",
      exportPath: "/repo/.anchor-code/exports/s.json",
      additionalNotes: "Only fix the auth bug first.",
      agentAuthor: "Claude",
    });
    expect(prompt).toContain("/repo/.anchor-code/exports/s.json");
    expect(prompt).toContain("Only fix the auth bug first.");
    expect(prompt).toContain("set author exactly to: Claude");
    expect(prompt).not.toContain("set author exactly to: grok-agent");
  });
});

describe("agentAuthorFromProfile", () => {
  it("prefers profile name then id", () => {
    expect(agentAuthorFromProfile({ id: "claude", name: "Claude" })).toBe(
      "Claude",
    );
    expect(agentAuthorFromProfile({ id: "omp", name: "  " })).toBe("omp");
    expect(agentAuthorFromProfile({})).toBe("agent");
  });
});

describe("feedbackTabTitle", () => {
  it("prefixes Feedback and truncates long titles", () => {
    expect(feedbackTabTitle("Review main")).toBe("Feedback · Review main");
    const long = "x".repeat(60);
    const title = feedbackTabTitle(long);
    expect(title.startsWith("Feedback · ")).toBe(true);
    expect(title.length).toBeLessThan(long.length);
  });
});

describe("countOpenFeedbackComments", () => {
  it("counts discussing and need_modify as open", () => {
    expect(
      countOpenFeedbackComments([
        { status: "discussing" },
        { status: "need_modify" },
        { status: "closed" },
        { status: "needs_modify" },
      ]),
    ).toEqual({ open: 3, needModify: 2 });
  });
});

describe("isAnchorReviewInstalled", () => {
  it("is true when any target is installed", () => {
    expect(
      isAnchorReviewInstalled({
        targets: [
          { installed: false },
          { installed: true },
        ],
      }),
    ).toBe(true);
    expect(isAnchorReviewInstalled({ targets: [{ installed: false }] })).toBe(
      false,
    );
  });
});
