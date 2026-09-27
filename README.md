# Spread

Artwork as a book you can hold. A page-curl book you can drop into any section of a website.

## Editor

Open https://spread.irina.love/editor/ (or `editor/` locally). Drop in up to 30 images; each is resized in the browser to 2400px WebP at quality 90, plus a 1000px copy, and small web-ready originals are kept untouched. Portrait pieces get a page each and landscape pieces go across both pages. Change layouts, captions, order, cover, colours and surface; the preview updates as you go. Undo with the button or Cmd/Ctrl+Z.

The draft lives in your browser (IndexedDB) until you publish. **Publish** (Chrome or Edge) asks for the `spread` folder and writes `book.json` plus the new image files straight into it, deleting files of images you removed. Other browsers download a zip to unzip into the folder instead. Then commit and push in GitHub Desktop.

Nothing is uploaded anywhere: there is no server or database.

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
