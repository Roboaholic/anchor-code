import {
  isValidElement,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { isMermaidLanguage, MermaidBlock } from "@/features/document/MermaidBlock";

/** Flatten react-markdown code children to a string. */
function codeChildToText(children: unknown): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(codeChildToText).join("");
  if (children == null) return "";
  return String(children);
}

/** Render a fenced ```mermaid block as a diagram; pass other code through. */
function CommentCode(
  props: ComponentPropsWithoutRef<"code"> & { inline?: boolean },
) {
  const { className, children, inline, ...rest } = props;
  const text = codeChildToText(children).replace(/\n$/, "");
  const isBlock =
    inline === false ||
    (typeof className === "string" && className.includes("language-")) ||
    text.includes("\n");

  if (isBlock && isMermaidLanguage(className)) {
    return <MermaidBlock chart={text} className="comment-md__mermaid" />;
  }
  return (
    <code className={className} {...rest}>
      {children}
    </code>
  );
}

/** Lift mermaid out of <pre> so the diagram isn't monospaced/preformatted. */
function CommentPre({ children, ...rest }: ComponentPropsWithoutRef<"pre">) {
  const only = Array.isArray(children)
    ? children.length === 1
      ? children[0]
      : null
    : children;
  if (isValidElement(only)) {
    const props = only.props as { className?: string; children?: ReactNode };
    if (isMermaidLanguage(props.className)) {
      const text = codeChildToText(props.children).replace(/\n$/, "");
      return <MermaidBlock chart={text} className="comment-md__mermaid" />;
    }
  }
  return <pre {...rest}>{children}</pre>;
}

/**
 * Open links in a new window, never replacing the workbench. In Electron,
 * target=_blank with noopener opens the system default browser.
 */
function CommentA({
  href,
  children,
  ...rest
}: ComponentPropsWithoutRef<"a">) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
      {children}
    </a>
  );
}

/**
 * Compact markdown renderer for comment bodies. Supports GFM tables/task lists
 * and renders ```mermaid fences as diagrams. Scaled down from the full document
 * MarkdownViewer to fit inside comment cards.
 */
export function CommentMarkdown({ content }: { content: string }) {
  return (
    <div className="comment-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: CommentCode,
          pre: CommentPre,
          a: CommentA,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
