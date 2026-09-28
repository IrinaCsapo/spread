# Spread: project memory

Artwork as a page-curl book, embeddable in any website. Live at https://spread.irina.love (GitHub Pages, `main`, repo root, `CNAME` binds the domain).

## Writing rules

- **No em dashes (—).** Use a comma, a full stop, or rewrite the sentence.

## Tech notes

- No build step. Plain `index.html`, `spread.js`, `spread.css`; the page curl is StPageFlip in `vendor/` (MIT).
- Multiple books: each is a folder `<slug>/` (book.json, images/, index.html generated from `template/book.html`). `books.json` is the shelf the home page and the editor's My books read. Root `book.json` is `{ "moved": "selected-works/book.json" }`; spread.js follows `moved` so old embeds keep working. Reserved slugs are listed in `RESERVED` in editor.js.
- Editor storage is per book: drafts under `draft:<slug>` in IndexedDB `kv`, files under `<slug>/<file>`. `migrateLegacy()` moves the pre-books single `draft` into `selected-works`. Duplicated books carry `copyOf` (repo paths) on images until Save points the new paths at the same blob SHAs.
- `editor/` is a browser-only editor (no server, no database): drafts and resized images live in IndexedDB; Save commits the book's book.json, new images, deletions, images/og.jpg, its index.html (template + `<!-- spread:og -->` block) and its books.json entry in one commit via the GitHub Git Data API (token in localStorage `spread-github`), then shows a publishing panel that polls the book's book.json for `updated` before opening `<slug>/?saved=<stamp>`. Download backup makes a stored (uncompressed) zip. Editor-only flags (`local`, `saved`, `ai`) are stripped on export. Limit 30 images; WebP at 1800px long edge (2400px if wider than 1.15:1), q0.84 stepping down to fit 450 KB (floor 0.66), plus a 1000px copy at 140 KB. `Make them lighter` re-encodes published images over budget (sizes read with HEAD requests). spread.js lazy-loads images and `warm()` switches the next pages to eager.
- `ai-worker/` is a Cloudflare Worker (Anthropic SDK, `claude-opus-5`, structured JSON output, `fallbacks: "default"`) that turns image copies into a book plan. Secrets: `ANTHROPIC_API_KEY`, `SPREAD_PASSPHRASE`. The editor's Arrange with AI calls it; AI-filled fields carry an `ai` map that export strips.
- The art promise must stay true: images go to Anthropic only via Arrange with AI; Anthropic's API doesn't train on inputs by default and deletes them within 30 days (checked 2026-09-27 at privacy.claude.com).
- `book.json` describes the book. `README.md` lists every key and page layout.
- New images: originals go in `source-images/` (git-ignored, never published), then `python3 tools/optimize.py` writes 2400px and 1000px WebP files to `images/`.
- The page-curl library rewrites each page's inline `style`, so per-book colours are set as CSS variables on the root element, never on pages.
- Pages alternate right/left after the cover; a `spread` layout must start on a left page (odd index).
