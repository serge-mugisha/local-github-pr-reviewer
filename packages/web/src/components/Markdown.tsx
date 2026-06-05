import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * GitHub PR descriptions embed media as raw HTML (`<img>`, `<video>`) pointing
 * at github.com/user-attachments URLs. Those assets are gated behind the
 * viewer's GitHub session, so they can't load from this local app — they'd
 * either render as literal "<img …>" text (react-markdown drops raw HTML) or
 * as a broken image. Viewing PR media isn't this tool's job, so we link out to
 * the original on GitHub instead of embedding it.
 *
 * To avoid pulling in rehype-raw/rehype-sanitize for something this small, we
 * rewrite the raw media tags to markdown image syntax with a regex, then the
 * `img` component override below renders every image (markdown or rewritten)
 * as a link. react-markdown still escapes any other raw HTML, so this stays
 * safe with no extra dependencies.
 */
function attr(tag: string, name: string): string {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  return m ? (m[2] ?? m[3] ?? "") : "";
}

export function rewriteRawMedia(body: string): string {
  return body
    .replace(/<(?:img|video|source)\b[^>]*>/gi, (tag) => {
      const src = attr(tag, "src");
      if (!src) return ""; // e.g. a bare <video> wrapper; its <source> carries the src
      const alt = attr(tag, "alt")
        .replace(/[[\]\r\n]/g, " ")
        .trim();
      return `![${alt}](<${src}>)`;
    })
    .replace(/<\/video>/gi, "");
}

function MediaLink({ href, alt }: { href: string; alt?: string }) {
  const text = alt?.trim() || "View image";
  if (!href) return <span className="media-embed disabled">{text}</span>;
  return (
    <a className="media-embed" href={href} target="_blank" rel="noreferrer">
      <span className="media-embed-icon" aria-hidden>
        🖼
      </span>
      <span className="media-embed-label">{text}</span>
      <span className="media-embed-ext" aria-hidden>
        ↗
      </span>
    </a>
  );
}

const components: Components = {
  img: ({ src, alt }) => <MediaLink href={typeof src === "string" ? src : ""} alt={alt} />,
};

export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {rewriteRawMedia(children)}
    </ReactMarkdown>
  );
}
