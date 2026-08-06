import { describe, expect, it } from "vitest";
import { completeAgentActivity, nextAgentActivity } from "./terminalStore";

describe("nextAgentActivity", () => {
  it("shows working after the user starts an agent turn", () => {
    expect(nextAgentActivity("idle", "started")).toBe("working");
  });

  it("keeps idle agents unlit when background output was not user-started", () => {
    expect(nextAgentActivity("idle", "completed")).toBe("idle");
  });

  it("marks a completed turn unread until viewed", () => {
    expect(nextAgentActivity("working", "completed")).toBe("completed-unread");
    expect(nextAgentActivity("completed-unread", "viewed")).toBe("idle");
  });

  it("does not stop the working indicator merely because the tab is viewed", () => {
    expect(nextAgentActivity("working", "viewed")).toBe("working");
  });
});

describe("completeAgentActivity", () => {
  it("clears the indicator when the completed agent is already viewed", () => {
    expect(completeAgentActivity("working", true)).toBe("idle");
  });

  it("keeps a background completion unread", () => {
    expect(completeAgentActivity("working", false)).toBe("completed-unread");
  });
});
