// Thin shared wrapper around react-markdown + remark-gfm so NoteCard's
// preview toggle and TwArticleDialog can both lazy-load the markdown stack
// (react-markdown + remark-gfm + micromark/mdast/hast, ~148 KB) instead of
// paying for it in the main chunk on every session. Deliberately no
// rehype-raw/allowDangerousHtml — both callers render untrusted note/article
// text and rely on embedded raw HTML staying inert.
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownView({
  children,
  components,
}: {
  children: string;
  components?: Components;
}) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {children}
    </ReactMarkdown>
  );
}
