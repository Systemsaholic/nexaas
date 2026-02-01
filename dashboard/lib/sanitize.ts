import DOMPurify from "dompurify";
import { marked } from "marked";

/**
 * Parse markdown to HTML and sanitize the output to prevent XSS.
 * Use this everywhere instead of raw `marked.parse()` + `dangerouslySetInnerHTML`.
 */
export function renderMarkdown(md: string): string {
  const raw = marked.parse(md, { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: [
      "h1", "h2", "h3", "h4", "h5", "h6",
      "p", "br", "hr",
      "ul", "ol", "li",
      "blockquote", "pre", "code",
      "strong", "em", "del", "s",
      "a", "img",
      "table", "thead", "tbody", "tr", "th", "td",
      "div", "span",
    ],
    ALLOWED_ATTR: ["href", "src", "alt", "title", "class", "target", "rel"],
    ALLOW_DATA_ATTR: false,
  });
}
