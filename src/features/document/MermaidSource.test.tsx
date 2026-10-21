// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  locateSelectionInMarkdown,
  selectionLineScope,
} from "@/core/annotations/mdSelection";

vi.mock("./MermaidBlock", () => ({
  isMermaidLanguage: (className?: string) => /language-mermaid/.test(className ?? ""),
  MermaidBlock: ({ chart }: { chart: string }) => (
    <div data-testid="diagram" data-chart={chart} />
  ),
}));

vi.mock("./CodeViewer", () => ({ CodeViewer: () => null }));
vi.mock("@/features/shell/orchestrate", () => ({ addCommentFromSelection: vi.fn() }));

import { MarkdownPre } from "./MarkdownViewer";

const DOC = [
  "# Title", // 1
  "", // 2
  "R is mentioned first.", // 3
  "", // 4
  "```mermaid", // 5
  "flowchart TB", // 6
  '    R["新增：CameraRuntime<br/>汇总预览与拍摄需求"]', // 7
  "    V -->|\"申请 / 释放\"| R", // 8
  "```", // 9
  "",
  "```ts", // 11
  "const x = 1;", // 12
  "```", // 13
  "",
].join("\n");

afterEach(cleanup);

function renderDoc() {
  return render(
    <article>
      <ReactMarkdown components={{ pre: MarkdownPre }}>{DOC}</ReactMarkdown>
    </article>,
  );
}

describe("mermaid fences in the rendered markdown", () => {
  it("shows the fence source as a code block followed by the diagram", () => {
    const { container } = renderDoc();
    const group = container.querySelector(".md-mermaid-group");
    expect(group).not.toBeNull();
    const pre = group!.querySelector("pre")!;
    expect(pre.querySelector("code")!.textContent).toBe(
      'flowchart TB\n    R["新增：CameraRuntime<br/>汇总预览与拍摄需求"]\n    V -->|"申请 / 释放"| R',
    );
    expect(pre.getAttribute("data-md-start-line")).toBe("5");
    expect(pre.getAttribute("data-md-end-line")).toBe("9");
    // Diagram comes after the source.
    const diagram = group!.querySelector('[data-testid="diagram"]')!;
    expect(pre.compareDocumentPosition(diagram) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(diagram.getAttribute("data-chart")).toContain("flowchart TB");
  });

  it("tags ordinary code blocks with their source lines too", () => {
    const { container } = renderDoc();
    const pres = [...container.querySelectorAll("pre")];
    const ts = pres.find((p) => p.textContent?.includes("const x"))!;
    expect(ts.getAttribute("data-md-start-line")).toBe("11");
    expect(ts.getAttribute("data-md-end-line")).toBe("13");
  });

  it("anchors a selection in the mermaid source to the right source line", () => {
    const { container } = renderDoc();
    const code = container.querySelector(".md-mermaid-group pre code")!;
    const textNode = code.firstChild as Text;
    const line = '    V -->|"申请 / 释放"| R';
    const at = textNode.data.indexOf(line);
    const range = document.createRange();
    range.setStart(textNode, at + 4);
    range.setEnd(textNode, at + line.length);

    const scope = selectionLineScope(range);
    expect(scope).toEqual({ startLine: 5, endLine: 9 });
    const anchor = locateSelectionInMarkdown(DOC, range.toString(), scope);
    expect(anchor).toMatchObject({ startLine: 8, endLine: 8, startColumn: 5 });

    // A bare "R" would otherwise anchor to line 3 (first occurrence).
    const rRange = document.createRange();
    const rAt = textNode.data.indexOf('R["');
    rRange.setStart(textNode, rAt);
    rRange.setEnd(textNode, rAt + 1);
    expect(locateSelectionInMarkdown(DOC, "R")?.startLine).toBe(3);
    expect(
      locateSelectionInMarkdown(DOC, "R", selectionLineScope(rRange))?.startLine,
    ).toBe(7);
  });

  it("does not scope selections that span outside one block", () => {
    const { container } = renderDoc();
    const h1 = container.querySelector("h1")!.firstChild!;
    const code = container.querySelector(".md-mermaid-group pre code")!.firstChild!;
    const range = document.createRange();
    range.setStart(h1, 0);
    range.setEnd(code, 3);
    expect(selectionLineScope(range)).toBeNull();
  });
});
