/*!
 * Spread: artwork as a book you can hold.
 * Embed:
 *   <link rel="stylesheet" href="https://spread.irina.love/spread.css">
 *   <div class="spread" data-book="https://spread.irina.love/book.json"></div>
 *   <script src="https://spread.irina.love/vendor/page-flip.browser.js"></script>
 *   <script src="https://spread.irina.love/spread.js"></script>
 * Page curl by StPageFlip (MIT), see vendor/page-flip.LICENSE.
 */
(function () {
  'use strict';

  var SURFACES = ['studio', 'linen', 'oak', 'concrete', 'blush', 'night'];

  function el(tag, cls, parent) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (parent) parent.appendChild(node);
    return node;
  }

  function text(tag, cls, value, parent) {
    if (!value) return null;
    var node = el(tag, cls, parent);
    node.textContent = value;
    return node;
  }

  // Returns img(name, alt, cls, parent) for one book. An image named in cfg.images uses
  // those files ({ src, small, width, smallWidth }); any other name falls back to
  // images/<name>.webp and images/<name>-1000.webp. Paths are relative to book.json.
  function imageMaker(cfg, base) {
    var list = cfg.images || {};
    function url(u) { return /^(blob:|data:|https?:|\/)/.test(u) ? u : base + u; }
    return function (name, alt, cls, parent) {
      var node = el('img', cls, parent);
      var entry = list[name];
      if (entry) {
        node.src = url(entry.src);
        if (entry.small) node.srcset = url(entry.small) + ' ' + (entry.smallWidth || 1000) + 'w, ' + url(entry.src) + ' ' + (entry.width || 2400) + 'w';
      } else {
        node.src = base + 'images/' + name + '.webp';
        node.srcset = base + 'images/' + name + '-1000.webp 1000w, ' + base + 'images/' + name + '.webp 2000w';
      }
      node.sizes = '(max-width: 700px) 100vw, 1200px';
      node.alt = alt || '';
      node.draggable = false;
      return node;
    };
  }

  function page(kind, extra) {
    var node = el('div', 'spread-page spread-page--' + kind + (extra ? ' ' + extra : ''));
    return node;
  }

  function buildCover(cfg, img, back) {
    var c = cfg.cover || {};
    var node = page(back ? 'back' : 'cover');
    node.dataset.density = 'hard';
    var inner = el('div', 'spread-cover', node);
    if (back) {
      text('p', 'spread-cover__mark', (cfg.back || {}).text, inner);
      return node;
    }
    text('p', 'spread-cover__eyebrow', c.eyebrow, inner);
    if (c.image) {
      var frame = el('div', 'spread-cover__plate', inner);
      img(c.image, c.alt, '', frame);
    }
    text('h2', 'spread-cover__title', c.title, inner);
    text('p', 'spread-cover__subtitle', c.subtitle, inner);
    return node;
  }

  function buildPages(p, img) {
    var node, box;
    switch (p.layout) {
      case 'endpaper':
        return [page('endpaper')];

      case 'text':
      case 'colophon':
        node = page(p.layout);
        box = el('div', 'spread-text', node);
        text('p', 'spread-eyebrow', p.eyebrow, box);
        text('h3', 'spread-heading', p.heading, box);
        text('p', 'spread-body', p.body, box);
        return [node];

      case 'plate':
        node = page('plate');
        var figure = el('figure', 'spread-plate', node);
        var frame = el('div', 'spread-plate__frame', figure);
        img(p.image, p.alt, '', frame);
        if (p.caption || p.note) {
          var cap = el('figcaption', 'spread-caption', figure);
          text('span', 'spread-caption__title', p.caption, cap);
          text('span', 'spread-caption__note', p.note, cap);
        }
        return [node];

      case 'bleed':
        node = page('bleed');
        img(p.image, p.alt, 'spread-fill', node).style.objectPosition = p.focus || '50% 50%';
        return [node];

      case 'half':
        node = page('half');
        var top = el('div', 'spread-half__image', node);
        img(p.image, p.alt, 'spread-fill', top).style.objectPosition = p.focus || '50% 50%';
        box = el('div', 'spread-text spread-text--half', node);
        text('p', 'spread-eyebrow', p.eyebrow, box);
        text('h3', 'spread-heading', p.heading, box);
        text('p', 'spread-body', p.body, box);
        return [node];

      case 'spread':
        // One image across the gutter: the same picture on two pages, each showing its half.
        var left = page('bleed', 'spread-page--span-left');
        var right = page('bleed', 'spread-page--span-right');
        img(p.image, p.alt, 'spread-span', left);
        img(p.image, '', 'spread-span', right).setAttribute('aria-hidden', 'true');
        return [left, right];

      default:
        console.warn('[spread] unknown layout "' + p.layout + '"');
        return [page('endpaper')];
    }
  }

  function setSurface(root, surface) {
    root.style.removeProperty('--surface-color');
    root.style.removeProperty('--surface-image');
    if (typeof surface === 'string') {
      root.dataset.surface = surface;
    } else if (surface && typeof surface === 'object') {
      root.dataset.surface = 'custom';
      if (surface.color) root.style.setProperty('--surface-color', surface.color);
      if (surface.image) root.style.setProperty('--surface-image', 'url("' + surface.image + '")');
    }
  }

  // opts.startPage opens the book at a page (the editor keeps your place between rebuilds).
  function mount(root, cfg, base, opts) {
    base = base || '';
    opts = opts || {};
    var img = imageMaker(cfg, base);
    root.classList.add('spread');
    root.innerHTML = '';
    setSurface(root, cfg.surface || 'studio');

    var stage = el('div', 'spread-stage', root);
    var shift = el('div', 'spread-shift', stage);
    var bookEl = el('div', 'spread-book', shift);

    var pages = [buildCover(cfg, img, false)];
    (cfg.pages || []).forEach(function (p) {
      var built = buildPages(p, img);
      if (p.layout === 'spread' && pages.length % 2 === 0) {
        console.warn('[spread] a "spread" starts on a right-hand page; add or remove a page before it so it lands across the gutter.');
      }
      pages = pages.concat(built);
    });
    // Cover + inner pages must be odd so the back cover closes the book on its own.
    if (pages.length % 2 === 0) pages.push(page('endpaper'));
    pages.push(buildCover(cfg, img, true));

    // Colours live on the root: the page-curl library rewrites each page's inline style.
    var cover = cfg.cover || {};
    if (cover.color) root.style.setProperty('--cover', cover.color);
    if (cover.ink) root.style.setProperty('--cover-ink', cover.ink);
    if (cfg.endpaper) root.style.setProperty('--endpaper', cfg.endpaper);

    pages.forEach(function (node, i) {
      node.classList.add(i === 0 || i % 2 === 0 ? 'is-right' : 'is-left');
      bookEl.appendChild(node);
    });

    var size = cfg.page || { width: 600, height: 800 };
    var start = Math.max(0, Math.min(opts.startPage || 0, pages.length - 1));
    var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    var flip = new St.PageFlip(bookEl, {
      width: size.width,
      height: size.height,
      size: 'stretch',
      minWidth: 240,
      maxWidth: size.width,
      minHeight: Math.round(240 * size.height / size.width),
      maxHeight: size.height,
      showCover: true,
      maxShadowOpacity: 0.45,
      flippingTime: reduced ? 350 : 900,
      mobileScrollSupport: true,
      usePortrait: true,
      startPage: start
    });
    flip.loadFromHTML(bookEl.querySelectorAll('.spread-page'));

    // Controls
    var bar = el('div', 'spread-controls', root);
    var prev = el('button', 'spread-btn', bar);
    prev.type = 'button';
    prev.setAttribute('aria-label', 'Previous page');
    prev.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
    var count = el('span', 'spread-count', bar);
    count.setAttribute('aria-live', 'polite');
    var next = el('button', 'spread-btn', bar);
    next.type = 'button';
    next.setAttribute('aria-label', 'Next page');
    next.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>';

    prev.addEventListener('click', function () { flip.flipPrev(); });
    next.addEventListener('click', function () { flip.flipNext(); });

    root.tabIndex = 0;
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', cfg.title || 'Book');
    function onKey(e) {
      if (e.key === 'ArrowRight') { flip.flipNext(); e.preventDefault(); }
      if (e.key === 'ArrowLeft') { flip.flipPrev(); e.preventDefault(); }
    }
    root.addEventListener('keydown', onKey);

    var total = flip.getPageCount();
    var pageEls = bookEl.querySelectorAll('.spread-page');

    // Decode the next few pages ahead of time so a turned page never lands blank.
    function warm(i) {
      for (var n = Math.max(0, i - 1); n < Math.min(pageEls.length, i + 5); n++) {
        pageEls[n].querySelectorAll('img').forEach(function (im) {
          if (!im.dataset.warm && im.decode) { im.dataset.warm = '1'; im.decode().catch(function () {}); }
        });
      }
    }

    function update(i) {
      warm(i);
      var portrait = flip.getOrientation() === 'portrait';
      var rect = flip.getBoundsRect();
      if (rect) shift.style.setProperty('--half-page', rect.pageWidth / 2 + 'px');
      // A closed book shows one page; slide it to the middle of the stage.
      shift.dataset.state = portrait ? 'open' : i === 0 ? 'front' : i >= total - 1 ? 'back' : 'open';
      prev.disabled = i === 0;
      next.disabled = i >= total - 1;
      if (i === 0) count.textContent = 'Cover';
      else if (i >= total - 1) count.textContent = 'Back';
      else if (portrait) count.textContent = i + ' / ' + (total - 2);
      else count.textContent = i + '–' + Math.min(i + 1, total - 2) + ' / ' + (total - 2);
    }
    flip.on('flip', function (e) { update(e.data); });
    flip.on('changeOrientation', function () { update(flip.getCurrentPageIndex()); });
    function onResize() { update(flip.getCurrentPageIndex()); }
    window.addEventListener('resize', onResize);
    update(start);

    return {
      flip: flip,
      setSurface: function (s) { setSurface(root, s); },
      destroy: function () {
        window.removeEventListener('resize', onResize);
        root.removeEventListener('keydown', onKey);
        flip.destroy();
        root.innerHTML = '';
      }
    };
  }

  function load(root) {
    var url = root.getAttribute('data-book');
    if (!url) return Promise.resolve(null);
    var base = url.indexOf('/') === -1 ? '' : url.slice(0, url.lastIndexOf('/') + 1);
    return fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (cfg) { return (root.spread = mount(root, cfg, base)); })
      .catch(function (err) { console.error('[spread] could not load ' + url, err); });
  }

  window.Spread = { mount: mount, load: load, surfaces: SURFACES };

  function auto() {
    document.querySelectorAll('.spread[data-book]').forEach(load);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', auto);
  else auto();
})();
