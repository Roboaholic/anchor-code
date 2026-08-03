import { describe, expect, it } from "vitest";
import {
  toRemoteCommentSession,
  toRemoteApplicationEvent,
  toRemoteTerminalInfo,
} from "./dtoMappers.js";

describe("remote DTO mappers", () => {
  it("only exposes stable terminal contract fields", () => {
    expect(toRemoteTerminalInfo({
      id: "t1",
      title: "Agent",
      cwd: "/workspace",
      status: "running",
      kind: "agent",
      agentId: "codex",
      internalHandle: "must-not-leak",
    })).toEqual({
      id: "t1",
      title: "Agent",
      cwd: "/workspace",
      status: "running",
      kind: "agent",
      agentId: "codex",
    });
  });

  it("maps workspace application events without transport internals", () => {
    expect(toRemoteApplicationEvent({
      type: "workspace",
      source: "desktop",
      workspace: {
        path: "/workspace-two",
        name: "workspace-two",
        hostProfileId: "local-default",
        hostKind: "local",
      },
    })).toEqual({
      type: "workspace",
      workspace: {
        path: "/workspace-two",
        name: "workspace-two",
        hostProfileId: "local-default",
        hostKind: "local",
      },
    });
  });

  it("maps comment sessions without leaking storage internals", () => {
    const mapped = toRemoteCommentSession({
      version: 1,
      id: "s1",
      title: "Review",
      status: "active",
      created_at: "2026-07-29T00:00:00.000Z",
      ended_at: null,
      author: "mobile-user",
      notes: "",
      comments: [],
      storageRevision: 9,
    });
    expect(mapped).toMatchObject({ id: "s1", status: "active", comments: [] });
    expect(mapped).not.toHaveProperty("storageRevision");
  });
});
