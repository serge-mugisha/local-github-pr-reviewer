import { describe, it, expect } from "vitest";
import { rewriteRawMedia } from "./Markdown.js";

describe("rewriteRawMedia", () => {
  it("rewrites a raw <img> tag to markdown image syntax", () => {
    const out = rewriteRawMedia(
      '<img width="708" alt="Screenshot 1" src="https://github.com/user-attachments/assets/abc" />',
    );
    expect(out).toBe("![Screenshot 1](<https://github.com/user-attachments/assets/abc>)");
  });

  it("handles single-quoted attrs and missing alt", () => {
    expect(rewriteRawMedia("<img src='https://x/y.png'>")).toBe("![](<https://x/y.png>)");
  });

  it("unwraps a <video> with a nested <source>", () => {
    const out = rewriteRawMedia(
      '<video controls><source src="https://x/v.mp4" type="video/mp4"></video>',
    );
    expect(out).toBe("![](<https://x/v.mp4>)");
  });

  it("strips brackets/newlines from alt so the link can't break", () => {
    const out = rewriteRawMedia('<img alt="a [b]\nc" src="https://x/z">');
    expect(out).toBe("![a  b  c](<https://x/z>)");
  });

  it("leaves non-media text untouched", () => {
    const md = "Some **bold** text and a [link](https://x).";
    expect(rewriteRawMedia(md)).toBe(md);
  });
});
