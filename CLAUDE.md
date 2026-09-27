# Spread: project memory

Artwork as a page-curl book, embeddable in any website. Live at https://spread.irina.love (GitHub Pages, `main`, repo root, `CNAME` binds the domain).

## Writing rules

- **No em dashes (—).** Use a comma, a full stop, or rewrite the sentence.

## Tech notes

- No build step. Plain `index.html`, `spread.js`, `spread.css`; the page curl is StPageFlip in `vendor/` (MIT).
- `editor/` is a browser-only editor (no server, no database): drafts and resized images live in IndexedDB; Publish writes into the repo folder via the File System Access API, or downloads a stored (uncompressed) zip. Limit 30 images; 2400px WebP q90 + 1000px copy.
- `book.json` describes the book. `README.md` lists every key and page layout.
- New images: originals go in `source-images/` (git-ignored, never published), then `python3 tools/optimize.py` writes 2400px and 1000px WebP files to `images/`.
- The page-curl library rewrites each page's inline `style`, so per-book colours are set as CSS variables on the root element, never on pages.
- Pages alternate right/left after the cover; a `spread` layout must start on a left page (odd index).
