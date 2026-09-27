# Spread: project memory

Artwork as a page-curl book, embeddable in any website. Live at https://spread.irina.love (GitHub Pages, `main`, repo root, `CNAME` binds the domain).

## Writing rules

- **No em dashes (—).** Use a comma, a full stop, or rewrite the sentence.

## Tech notes

- No build step. Plain `index.html`, `spread.js`, `spread.css`; the page curl is StPageFlip in `vendor/` (MIT).
- `editor/` is a browser-only editor (no server, no database): drafts and resized images live in IndexedDB; Save commits book.json, new images, deletions, images/og.jpg and the `<!-- spread:og -->` block in index.html in one commit via the GitHub Git Data API (token in localStorage `spread-github`), then redirects to `../?saved=<stamp>`, where index.html polls book.json for `updated`. Download backup makes a stored (uncompressed) zip. Editor-only flags (`local`, `saved`, `ai`) are stripped on export. Limit 30 images; 2400px WebP q90 + 1000px copy.
- `ai-worker/` is a Cloudflare Worker (Anthropic SDK, `claude-opus-5`, structured JSON output, `fallbacks: "default"`) that turns image copies into a book plan. Secrets: `ANTHROPIC_API_KEY`, `SPREAD_PASSPHRASE`. The editor's Arrange with AI calls it; AI-filled fields carry an `ai` map that export strips.
- The art promise must stay true: images go to Anthropic only via Arrange with AI; Anthropic's API doesn't train on inputs by default and deletes them within 30 days (checked 2026-09-27 at privacy.claude.com).
- `book.json` describes the book. `README.md` lists every key and page layout.
- New images: originals go in `source-images/` (git-ignored, never published), then `python3 tools/optimize.py` writes 2400px and 1000px WebP files to `images/`.
- The page-curl library rewrites each page's inline `style`, so per-book colours are set as CSS variables on the root element, never on pages.
- Pages alternate right/left after the cover; a `spread` layout must start on a left page (odd index).
