# Spread

Artwork as a book you can page through. A page-curl book you can drop into any section of a website.

## Editor

Open https://spread.irina.love/editor/ (or `editor/` locally). Drop in up to 30 images; each is resized in the browser to WebP, 1800px on the long edge (2400px for landscape pieces that run across both pages) with a 450 KB budget, plus a 1000px copy with a 140 KB budget. Quality starts at 84 (80 for the copy) and steps down only as far as needed to fit, never below 66. The editor shows the before and after size, labels every thumbnail with its size, and offers **Make them lighter** when images already in the book are over budget; press Save afterwards. The book lazy-loads pages, warming the next few as the reader turns. Portrait pieces get a page each and landscape pieces go across both pages. Change layouts, captions, order, cover, colours and surface; the preview updates as you go. Undo with the button or Cmd/Ctrl+Z.

The draft lives in your browser (IndexedDB) until you save. **Save** makes one commit to the repo through the GitHub API: `book.json`, new image files, deletions of removed images, a 1200×630 `images/og.jpg` link-preview picture of the cover, and the title/description tags between `<!-- spread:og -->` markers in `index.html`. It then opens the main page, which waits for GitHub Pages to publish (it polls `book.json` for the new `updated` stamp) and shows the share link, WhatsApp and embed code. Save needs a fine-grained GitHub token with Contents: Read and write on this repo only, entered once under Save settings and kept in that browser. **Download backup** saves a zip of `book.json` and the images added in this browser.

After saving from the editor, pull in GitHub Desktop before pushing code changes, since Save commits straight to `main` on GitHub.

Nothing is uploaded anywhere unless you use Arrange with AI: there is no database.

### Arrange with AI

The editor opens in a simple view: images, **Arrange with AI** and the preview. **Edit book** shows the cover and page controls.

Arrange with AI sends the 1000px copy of every image to the Spread AI Worker (`ai-worker/`), which asks Claude (`claude-opus-5`) for a plan: order, layouts, cover image, cover/ink/endpaper colours, surface, alt text, notes, title suggestions and title-page text. Text you wrote is kept; what Claude fills in is tinted and tagged in Edit book until you edit it or press Keep, and Save asks before sending out unconfirmed titles. One Undo reverts the whole arrangement. Roughly 1,000 input tokens per image, so a 30-image book costs about 20 to 40p.

The Worker holds the Anthropic key; the editor only knows the Worker's address and a passphrase (saved in the browser under AI settings). See `ai-worker/README.md` to deploy it.

## Add images from the command line

1. Put originals in `source-images/` (jpg, png, webp, tif).
2. Run `python3 tools/optimize.py`.
3. Each image becomes `images/<name>.webp` (2000px) and `images/<name>-1000.webp` (1000px), with metadata stripped.
4. Refer to it in `book.json` by its file name, without the extension.

## book.json

| key        | what it does |
|------------|--------------|
| `page`     | page size in px at its largest, e.g. `{ "width": 600, "height": 800 }` (3:4) |
| `surface`  | `studio`, `linen`, `oak`, `concrete`, `blush`, `night`, or `{ "color": "#…", "image": "url" }` |
| `cover`    | `color`, `ink`, `eyebrow`, `title`, `subtitle`, `image`, `alt` |
| `endpaper` | colour of the endpapers |
| `back`     | `text` shown on the back cover |
| `pages`    | the pages in order, see below |
| `images`   | optional. `{ name: { src, small, width, height, smallWidth } }`, paths relative to book.json. Names not listed fall back to `images/<name>.webp` and `images/<name>-1000.webp` |

Page layouts:

- `plate`: one piece on a paper margin. Takes `image`, `alt`, `caption`, `note`.
- `bleed`: fills one page edge to edge. Takes `image`, `alt`, and an optional `focus` crop point like `"50% 30%"`.
- `spread`: one image across both pages. It must start on a left-hand page, and the console warns if it doesn't.
- `half`: image on the top half, text below. Takes `image`, `alt`, `focus`, `eyebrow`, `heading`, `body`.
- `text`: takes `eyebrow`, `heading`, `body`.
- `colophon`: a small closing note, set in `body`.
- `endpaper`: a plain coloured page.

The cover is page 0 and sits on the right. After it, pages alternate left, right, left, right. If the count comes out uneven, a blank endpaper is added automatically so the back cover closes the book.

## Embed

```html
<link rel="stylesheet" href="https://spread.irina.love/spread.css">
<div class="spread" data-book="https://spread.irina.love/book.json"></div>
<script src="https://spread.irina.love/vendor/page-flip.browser.js"></script>
<script src="https://spread.irina.love/spread.js"></script>
```

## Hosting

Live at https://spread.irina.love through GitHub Pages, deployed from `main` at the repo root. The `CNAME` file binds the domain. DNS is a GoDaddy CNAME record, `spread` pointing to `irinacsapo.github.io`. Push to `main` and the site updates within a minute or two.

Page curl by [StPageFlip](https://github.com/Nodlik/StPageFlip) (MIT).
