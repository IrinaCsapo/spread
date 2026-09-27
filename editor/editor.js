/*
 * Spread editor. Builds book.json and web-size images entirely in the browser.
 * Nothing is uploaded: the draft (book + resized image files) lives in IndexedDB until
 * Publish writes it into the spread folder (Chrome/Edge) or a zip is downloaded.
 */
(function () {
  'use strict';

  var MAX_IMAGES = 30;
  var BIG = { edge: 2400, quality: 0.9 };
  var SMALL = { edge: 1000, quality: 0.85 };
  // An original already this small (and web-friendly) is kept byte for byte: no re-encode, no loss.
  var KEEP_ORIGINAL_BYTES = 1.2 * 1024 * 1024;
  var BASE = '../';

  var LAYOUTS = [
    ['plate', 'One piece, with margin'],
    ['bleed', 'Full page'],
    ['spread', 'Across both pages'],
    ['half', 'Half image, half text'],
    ['text', 'Text'],
    ['colophon', 'Closing note'],
    ['endpaper', 'Blank (endpaper)']
  ];
  var FIELDS = {
    plate: ['image', 'caption', 'note', 'alt'],
    bleed: ['image', 'focus', 'alt'],
    spread: ['image', 'alt'],
    half: ['image', 'focus', 'eyebrow', 'heading', 'body', 'alt'],
    text: ['eyebrow', 'heading', 'body'],
    colophon: ['body'],
    endpaper: []
  };
  var LABELS = {
    image: 'Image', caption: 'Title or caption', note: 'Note', alt: 'Description (for screen readers)',
    focus: 'Crop from', eyebrow: 'Small heading', heading: 'Heading', body: 'Text'
  };
  var FOCUS = [['50% 50%', 'Centre'], ['50% 20%', 'Top'], ['50% 80%', 'Bottom'], ['20% 50%', 'Left'], ['80% 50%', 'Right']];

  var $ = function (id) { return document.getElementById(id); };

  /* ---------- storage: IndexedDB, wrapped so the editor still works without it ---------- */

  var dbPromise = new Promise(function (resolve) {
    try {
      var req = indexedDB.open('spread-editor', 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore('files');
        req.result.createObjectStore('kv');
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
    } catch (e) { resolve(null); }
  });

  function idb(store, mode, fn) {
    return dbPromise.then(function (db) {
      if (!db) return undefined;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(store, mode);
          var req = fn(tx.objectStore(store));
          tx.oncomplete = function () { resolve(req && req.result); };
          tx.onerror = tx.onabort = function () { resolve(undefined); };
        } catch (e) { resolve(undefined); }
      });
    });
  }
  var put = function (store, key, val) { return idb(store, 'readwrite', function (s) { return s.put(val, key); }); };
  var get = function (store, key) { return idb(store, 'readonly', function (s) { return s.get(key); }); };
  var clear = function (store) { return idb(store, 'readwrite', function (s) { return s.clear(); }); };

  /* ---------- state ---------- */

  var book = null;          // book.json as it will be published
  var removed = [];         // published image files no longer used, deleted on publish
  var blobs = {};           // file name -> Blob for images made in this browser
  var urls = {};            // file name -> object URL
  var history = [];
  var preview = null;
  var currentPage = 0;

  function snapshot() { return JSON.stringify({ book: book, removed: removed }); }
  function restore(s) { var o = JSON.parse(s); book = o.book; removed = o.removed; }

  var saveTimer;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { put('kv', 'draft', { book: book, removed: removed, at: Date.now() }); }, 250);
    $('draft-note').textContent = 'Draft saved in this browser. Publish when you are ready to put it online.';
  }

  function commit(mutate) {
    history.push(snapshot());
    if (history.length > 50) history.shift();
    mutate();
    save();
    render();
  }

  function undo() {
    if (!history.length) return;
    restore(history.pop());
    save();
    render();
  }

  /* ---------- helpers ---------- */

  function fileOf(path) { return path.replace(/^images\//, ''); }
  function imageNames() { return Object.keys(book.images || {}); }
  function pageLen(p) { return p.layout === 'spread' ? 2 : 1; }
  // Index in the book of the first leaf of pages[i] (the cover is 0, so the first inner page is 1).
  function startOf(i) {
    var n = 1;
    for (var k = 0; k < i; k++) n += pageLen(book.pages[k]);
    return n;
  }
  // Object URL for a file made in this browser, created once and reused.
  function localUrl(f) {
    if (!blobs[f]) return null;
    return urls[f] || (urls[f] = URL.createObjectURL(blobs[f]));
  }
  function thumbUrl(name) {
    var e = book.images[name];
    if (!e) return '';
    return (e.local && localUrl(fileOf(e.small || e.src))) || BASE + (e.small || e.src);
  }
  function usedOn(name) {
    var out = [];
    book.pages.forEach(function (p, i) { if (p.image === name) out.push(i); });
    return out;
  }
  function slug(s) {
    return s.replace(/\.[^.]+$/, '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
  }
  function uniqueName(base) {
    var name = base, n = 2;
    while (book.images[name]) name = base + '-' + n++;
    return name;
  }

  var toastTimer;
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 4000);
  }

  /* ---------- loading ---------- */

  function normalise(cfg, manifest) {
    cfg.images = cfg.images || {};
    cfg.pages = cfg.pages || [];
    cfg.cover = cfg.cover || {};
    var names = cfg.pages.map(function (p) { return p.image; }).concat(cfg.cover.image);
    names.forEach(function (n) {
      if (!n || cfg.images[n]) return;
      var m = manifest && manifest[n] && manifest[n].files;
      var big = m && (m['2000'] || m['2400']);
      var small = m && m['1000'];
      cfg.images[n] = {
        src: 'images/' + n + '.webp',
        small: 'images/' + n + '-1000.webp',
        width: big ? big.width : 2000,
        height: big ? big.height : 2000,
        smallWidth: small ? small.width : 1000
      };
    });
    return cfg;
  }

  function loadLive() {
    var bookReq = fetch(BASE + 'book.json', { cache: 'no-store' }).then(function (r) { return r.json(); });
    var manReq = fetch(BASE + 'images/manifest.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
    return Promise.all([bookReq, manReq]).then(function (res) {
      book = normalise(res[0], res[1]);
      removed = [];
      blobs = {};
      history = [];
      $('draft-note').textContent = 'Showing the published book. Your changes are kept in this browser as a draft.';
    });
  }

  function loadDraft() {
    return get('kv', 'draft').then(function (d) {
      if (!d || !d.book) return false;
      book = d.book;
      removed = d.removed || [];
      var local = [];
      imageNames().forEach(function (n) {
        var e = book.images[n];
        if (e.local) local.push(fileOf(e.src), fileOf(e.small));
      });
      return Promise.all(local.map(function (f) {
        return get('files', f).then(function (b) { if (b) blobs[f] = b; });
      })).then(function () {
        var when = new Date(d.at || Date.now());
        $('draft-note').textContent = 'Draft from ' + when.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) +
          ', kept in this browser. "Start over" goes back to the published book.';
        return true;
      });
    });
  }

  /* ---------- image processing ---------- */

  function decode(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () { return viaImg(file); });
    }
    return viaImg(file);
  }
  function viaImg(file) {
    return new Promise(function (resolve, reject) {
      var im = new Image();
      var u = URL.createObjectURL(file);
      im.onload = function () { resolve(im); };
      im.onerror = function () { URL.revokeObjectURL(u); reject(new Error('unreadable')); };
      im.src = u;
    });
  }
  function dims(src) { return { w: src.naturalWidth || src.width, h: src.naturalHeight || src.height }; }

  // Downscale in halving steps with high-quality smoothing: sharper than one big jump.
  function resize(src, edge) {
    var d = dims(src);
    var scale = Math.min(1, edge / Math.max(d.w, d.h));
    var tw = Math.round(d.w * scale), th = Math.round(d.h * scale);
    var cur = src, cw = d.w, ch = d.h;
    do {
      cw = Math.max(tw, Math.round(cw / 2));
      ch = Math.max(th, Math.round(ch / 2));
      if (scale === 1) { cw = tw; ch = th; }
      var c = document.createElement('canvas');
      c.width = cw; c.height = ch;
      var ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(cur, 0, 0, cw, ch);
      cur = c;
    } while (cw > tw || ch > th);
    return cur;
  }

  function encode(canvas, quality) {
    return new Promise(function (resolve) {
      canvas.toBlob(function (b) {
        if (b && b.type === 'image/webp') return resolve(b);
        // Browsers that cannot write WebP (older Safari) get a high-quality JPEG instead.
        canvas.toBlob(resolve, 'image/jpeg', Math.min(0.95, quality + 0.03));
      }, 'image/webp', quality);
    });
  }
  function extOf(type) { return { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' }[type] || 'webp'; }

  function processFile(file) {
    return decode(file).then(function (src) {
      var d = dims(src);
      var bigCanvas = resize(src, BIG.edge);
      var smallCanvas = resize(src, SMALL.edge);
      var keep = Math.max(d.w, d.h) <= BIG.edge && file.size <= KEEP_ORIGINAL_BYTES &&
        /^image\/(jpeg|webp)$/.test(file.type);
      return Promise.all([
        keep ? Promise.resolve(file) : encode(bigCanvas, BIG.quality),
        encode(smallCanvas, SMALL.quality)
      ]).then(function (out) {
        if (src.close) src.close();
        return {
          big: out[0], small: out[1],
          width: bigCanvas.width, height: bigCanvas.height,
          smallWidth: smallCanvas.width, smallHeight: smallCanvas.height
        };
      });
    });
  }

  function addFiles(list) {
    var files = Array.prototype.filter.call(list, function (f) { return /^image\//.test(f.type) || /\.(heic|heif)$/i.test(f.name); });
    if (!files.length) return;
    var room = MAX_IMAGES - imageNames().length;
    if (room <= 0) { toast('This book already has 30 images. Remove one to add another.'); return; }
    var skipped = files.length - room;
    files = files.slice(0, room);

    var progress = $('progress');
    progress.hidden = false;
    var made = [], failed = [];

    files.reduce(function (chain, file, i) {
      return chain.then(function () {
        progress.textContent = 'Resizing ' + (i + 1) + ' of ' + files.length + ': ' + file.name;
        return processFile(file).then(function (r) {
          var name = uniqueName(slug(file.name));
          var bigFile = name + '.' + extOf(r.big.type);
          var smallFile = name + '-1000.' + extOf(r.small.type);
          blobs[bigFile] = r.big;
          blobs[smallFile] = r.small;
          return Promise.all([put('files', bigFile, r.big), put('files', smallFile, r.small)]).then(function () {
            made.push({
              name: name,
              entry: {
                src: 'images/' + bigFile, small: 'images/' + smallFile,
                width: r.width, height: r.height, smallWidth: r.smallWidth, local: true
              },
              kb: Math.round(r.big.size / 1024)
            });
          });
        }).catch(function () { failed.push(file.name); });
      });
    }, Promise.resolve()).then(function () {
      progress.hidden = true;
      if (made.length) {
        commit(function () {
          made.forEach(function (m) { book.images[m.name] = m.entry; });
          placeNew(made);
          if (!book.cover.image) book.cover.image = made[0].name;
        });
      }
      var msg = made.length ? 'Added ' + made.length + (made.length === 1 ? ' image' : ' images') +
        ' (' + made.map(function (m) { return m.kb + 'KB'; }).join(', ') + ').' : '';
      if (skipped > 0) msg += ' ' + skipped + ' not added: the limit is 30.';
      if (failed.length) msg += ' Could not read ' + failed.join(', ') + '. Try exporting it as JPEG.';
      toast(msg.trim(), 7000);
    });
  }

  // Auto layout: portrait pieces get a page each, landscape pieces go across the fold.
  // A landscape piece that would start on a right-hand page swaps places with the next portrait.
  function placeNew(made) {
    var at = -1;
    book.pages.forEach(function (p, i) { if (p.image) at = i; });
    if (at === -1) {
      at = book.pages.length;
      while (at > 0 && /^(endpaper|colophon)$/.test(book.pages[at - 1].layout)) at--;
    } else {
      at += 1;
    }
    var queue = made.map(function (m) {
      var e = m.entry;
      return { name: m.name, wide: e.width / e.height > 1.15 };
    });
    var leaf = startOf(at);
    var out = [];
    while (queue.length) {
      var item = queue[0];
      if (item.wide && leaf % 2 === 0) {
        var k = queue.findIndex(function (q) { return !q.wide; });
        if (k > 0) item = queue[k];
      }
      queue.splice(queue.indexOf(item), 1);
      var page = { layout: item.wide ? 'spread' : 'plate', image: item.name };
      out.push(page);
      leaf += pageLen(page);
    }
    Array.prototype.splice.apply(book.pages, [at, 0].concat(out));
  }

  function removeImage(name) {
    commit(function () {
      var e = book.images[name];
      delete book.images[name];
      book.pages = book.pages.filter(function (p) { return p.image !== name; });
      if (book.cover.image === name) book.cover.image = imageNames()[0] || '';
      if (!e.local) removed.push(e.src, e.small);
    });
    toast('Image removed. Undo brings it back.');
  }

  /* ---------- rendering ---------- */

  function h(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'class') n.className = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }

  // Text edits change the book in place; one undo step per field, taken when it gains focus.
  // A field Claude filled carries obj.ai[key] and is marked until you edit it or press Keep.
  function textField(obj, key, label, multiline) {
    var isAI = !!(obj.ai && obj.ai[key]);
    var tag, keep;
    function accept() {
      if (obj.ai) delete obj.ai[key];
      input.classList.remove('is-ai');
      if (tag) tag.remove();
      if (keep) keep.remove();
      save();
    }
    var input = h(multiline ? 'textarea' : 'input', {
      class: 'input' + (isAI ? ' is-ai' : ''), rows: multiline ? 3 : false, type: multiline ? false : 'text',
      onfocus: function () { history.push(snapshot()); $('undo').disabled = false; },
      oninput: function () { obj[key] = input.value; if (isAI) accept(); save(); schedulePreview(); }
    });
    input.value = obj[key] || '';
    if (isAI) {
      tag = h('span', { class: 'ai-tag', text: key === 'caption' ? 'AI suggestion' : 'AI' });
      keep = h('button', { type: 'button', class: 'link keep', text: 'Keep', onclick: function (e) { e.preventDefault(); accept(); } });
    }
    return h('label', { class: 'field' }, [h('span', {}, [label, tag, keep]), input]);
  }

  function selectField(label, options, value, onchange) {
    var sel = h('select', { class: 'input', onchange: function () { onchange(sel.value); } },
      options.map(function (o) { return h('option', { value: o[0], text: o[1] }); }));
    sel.value = value;
    return h('label', { class: 'field' }, [h('span', { text: label }), sel]);
  }

  function colourField(obj, key, label, fallback) {
    var input = h('input', {
      type: 'color', class: 'swatch',
      onfocus: function () { history.push(snapshot()); $('undo').disabled = false; },
      oninput: function () { obj[key] = input.value; save(); schedulePreview(); }
    });
    input.value = obj[key] || fallback;
    return h('label', { class: 'field field--colour' }, [h('span', { text: label }), input]);
  }

  function renderTray() {
    var names = imageNames();
    $('count').textContent = names.length + ' of ' + MAX_IMAGES;
    $('count').classList.toggle('is-full', names.length >= MAX_IMAGES);
    var tray = $('tray');
    tray.innerHTML = '';
    names.forEach(function (name) {
      var on = usedOn(name);
      var e = book.images[name];
      tray.appendChild(h('li', { class: 'thumb' + (on.length ? '' : ' is-unused') }, [
        h('button', {
          type: 'button', class: 'thumb-img', title: on.length ? 'Go to its page' : 'Not on any page yet',
          onclick: function () { if (on.length) goTo(on[0]); }
        }, [h('img', { src: thumbUrl(name), alt: e.alt || name, loading: 'lazy' })]),
        h('button', {
          type: 'button', class: 'thumb-x', 'aria-label': 'Remove ' + name,
          onclick: function () { removeImage(name); }
        }, ['×']),
        e.local ? h('span', { class: 'thumb-tag', text: 'new' }) : null
      ]));
    });
  }

  function renderCover() {
    var c = book.cover;
    var box = $('cover-fields');
    box.innerHTML = '';
    var imgOpts = [['', 'No image']].concat(imageNames().map(function (n) { return [n, n]; }));
    box.append(
      textField(c, 'eyebrow', 'Small heading'),
      textField(c, 'title', 'Title'),
      textField(c, 'subtitle', 'Subtitle'),
      selectField('Cover image', imgOpts, c.image || '', function (v) { commit(function () { c.image = v; }); }),
      h('div', { class: 'row' }, [
        colourField(c, 'color', 'Cover', '#1b3fd0'),
        colourField(c, 'ink', 'Cover text', '#ffffff'),
        colourField(book, 'endpaper', 'Endpapers', '#e8331f')
      ]),
      selectField('Surface', Spread.surfaces.map(function (s) { return [s, s[0].toUpperCase() + s.slice(1)]; }),
        typeof book.surface === 'string' ? book.surface : 'studio',
        function (v) { commit(function () { book.surface = v; }); }),
      textField(book.back = book.back || {}, 'text', 'Back cover text'),
      textField(book, 'title', 'Book name (read out by screen readers)')
    );
  }

  function renderPages() {
    var list = $('pages');
    list.innerHTML = '';
    var imgOpts = imageNames().map(function (n) { return [n, n]; });
    book.pages.forEach(function (p, i) {
      var leaf = startOf(i);
      var where = p.layout === 'spread' ? 'Pages ' + leaf + '–' + (leaf + 1) : 'Page ' + leaf + (leaf % 2 ? ', left' : ', right');
      var warn = null;
      if (p.layout === 'spread' && leaf % 2 === 0) {
        warn = h('p', { class: 'warn' }, [
          'This starts on a right-hand page, so the image would break across two spreads. ',
          h('button', {
            type: 'button', class: 'link', text: 'Add a blank page before it',
            onclick: function () { commit(function () { book.pages.splice(i, 0, { layout: 'endpaper' }); }); }
          })
        ]);
      }
      if (FIELDS[p.layout] && FIELDS[p.layout].indexOf('image') !== -1 && !book.images[p.image]) {
        warn = h('p', { class: 'warn', text: imgOpts.length ? 'Choose an image for this page.' : 'Add an image first.' });
      }

      var fields = (FIELDS[p.layout] || []).map(function (key) {
        if (key === 'image') {
          return imgOpts.length ? selectField('Image', imgOpts, p.image || '', function (v) { commit(function () { p.image = v; }); }) : null;
        }
        if (key === 'focus') {
          return selectField('Crop from', FOCUS, p.focus || '50% 50%', function (v) { commit(function () { p.focus = v; }); });
        }
        return textField(p, key, LABELS[key], key === 'body');
      });

      var thumb = p.image && book.images[p.image] ? h('img', { class: 'page-thumb', src: thumbUrl(p.image), alt: '' }) : null;

      list.appendChild(h('li', { class: 'page-card' + (p.layout === 'spread' ? ' is-spread' : '') }, [
        h('div', { class: 'page-head' }, [
          h('button', { type: 'button', class: 'page-where', text: where, onclick: function () { goTo(i); } }),
          h('div', { class: 'page-tools' }, [
            h('button', { type: 'button', class: 'icon', 'aria-label': 'Move up', disabled: i === 0, text: '↑',
              onclick: function () { commit(function () { book.pages.splice(i - 1, 0, book.pages.splice(i, 1)[0]); }); } }),
            h('button', { type: 'button', class: 'icon', 'aria-label': 'Move down', disabled: i === book.pages.length - 1, text: '↓',
              onclick: function () { commit(function () { book.pages.splice(i + 1, 0, book.pages.splice(i, 1)[0]); }); } }),
            h('button', { type: 'button', class: 'icon', 'aria-label': 'Remove page', text: '×',
              onclick: function () { commit(function () { book.pages.splice(i, 1); }); toast('Page removed. Its image is still in your images.'); } })
          ])
        ]),
        h('div', { class: 'page-body' }, [
          thumb,
          h('div', { class: 'fields' }, [
            selectField('Layout', LAYOUTS, p.layout, function (v) {
              commit(function () {
                p.layout = v;
                if (FIELDS[v].indexOf('image') !== -1 && !p.image) p.image = imageNames()[0];
              });
            })
          ].concat(fields))
        ]),
        warn
      ]));
    });
  }

  function previewConfig() {
    var cfg = JSON.parse(JSON.stringify(book));
    Object.keys(cfg.images).forEach(function (n) {
      var e = cfg.images[n];
      if (!e.local) return;
      ['src', 'small'].forEach(function (key) {
        var u = localUrl(fileOf(e[key]));
        if (u) e[key] = u;
      });
    });
    return cfg;
  }

  var previewTimer;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 350);
  }
  function renderPreview() {
    var root = $('preview');
    if (preview) {
      currentPage = preview.flip.getCurrentPageIndex();
      preview.destroy();
    }
    preview = Spread.mount(root, previewConfig(), BASE, { startPage: currentPage });
  }

  function goTo(i) {
    if (!preview) return;
    var leaf = startOf(i);
    try { preview.flip.flip(leaf); } catch (e) { preview.flip.turnToPage(leaf); }
  }

  function render() {
    $('undo').disabled = !history.length;
    renderTray();
    renderCover();
    renderPages();
    renderPreview();
  }

  /* ---------- publishing ---------- */

  function exportJSON() {
    var out = {};
    ['title', 'page', 'surface', 'cover', 'endpaper', 'back', 'pages', 'images'].forEach(function (k) {
      if (book[k] !== undefined) out[k] = book[k];
    });
    Object.keys(book).forEach(function (k) { if (!(k in out)) out[k] = book[k]; });
    out = JSON.parse(JSON.stringify(out));
    Object.keys(out.images).forEach(function (n) { delete out.images[n].local; delete out.images[n].saved; });
    out.pages.concat(out.cover).forEach(function (p) { delete p.ai; });
    return JSON.stringify(out, null, 2) + '\n';
  }

  function localFiles() {
    var out = [];
    imageNames().forEach(function (n) {
      var e = book.images[n];
      if (!e.local) return;
      [e.src, e.small].forEach(function (p) { if (blobs[fileOf(p)]) out.push([fileOf(p), blobs[fileOf(p)]]); });
    });
    return out;
  }

  function stillUsed(path) {
    return imageNames().some(function (n) { return book.images[n].src === path || book.images[n].small === path; });
  }

  // Titles Claude suggested go out only once you have seen them.
  function titlesOk() {
    var n = book.pages.filter(function (p) { return p.ai && p.ai.caption && p.caption; }).length;
    return !n || confirm(n + (n === 1 ? ' title is' : ' titles are') + ' still an AI suggestion. Save ' + (n === 1 ? 'it as it is' : 'them as they are') + '?\n\nChoose Cancel to review them under Edit book.');
  }

  /* ---------- Save: one commit to the spread repo through the GitHub API ---------- */

  var OG_START = '<!-- spread:og -->';
  var OG_END = '<!-- /spread:og -->';

  function ghSettings() {
    try { return JSON.parse(localStorage.getItem('spread-github') || 'null') || {}; } catch (e) { return {}; }
  }
  function askGh() {
    var s = ghSettings();
    $('gh-repo').value = s.repo || 'IrinaCsapo/spread';
    $('gh-token').value = s.token || '';
    return new Promise(function (resolve) {
      var d = $('gh-dialog');
      d.addEventListener('close', function once() {
        d.removeEventListener('close', once);
        if (d.returnValue !== 'save') return resolve(null);
        var next = { repo: $('gh-repo').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/+$/, ''), token: $('gh-token').value.trim() };
        try { localStorage.setItem('spread-github', JSON.stringify(next)); } catch (e) {}
        resolve(next);
      });
      d.showModal();
    });
  }

  function ghApi(s, method, path, body) {
    return fetch('https://api.github.com/repos/' + s.repo + path, {
      method: method,
      headers: {
        Authorization: 'Bearer ' + s.token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store'
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (r.ok) return data;
        var err = new Error(data.message || 'GitHub said ' + r.status);
        err.status = r.status;
        throw err;
      });
    });
  }

  function escapeHtml(t) {
    return String(t || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Link previews (WhatsApp, iMessage, Slack) read these tags; they cannot run the book's JavaScript.
  function ogBlock(site) {
    var c = book.cover || {};
    var title = [c.eyebrow, c.title].filter(Boolean).join(', ') || book.title || 'Spread';
    var desc = c.subtitle ? c.subtitle + '. A book you can page through.' : 'A book you can page through.';
    return [
      OG_START,
      '  <title>' + escapeHtml(title) + ' · Spread</title>',
      '  <meta name="description" content="' + escapeHtml(desc) + '">',
      '  <meta property="og:type" content="website">',
      '  <meta property="og:url" content="' + site + '">',
      '  <meta property="og:title" content="' + escapeHtml(title) + '">',
      '  <meta property="og:description" content="' + escapeHtml(desc) + '">',
      '  <meta property="og:image" content="' + site + 'images/og.jpg">',
      '  <meta property="og:image:width" content="1200">',
      '  <meta property="og:image:height" content="630">',
      '  <meta name="twitter:card" content="summary_large_image">',
      '  ' + OG_END
    ].join('\n');
  }

  // The picture a shared link shows: the cover image on the cover colour, with the title.
  function ogImage() {
    var c = book.cover || {};
    if (!c.image || !book.images[c.image]) return Promise.resolve(null);
    return Promise.all([
      smallBlob(c.image).then(decode),
      document.fonts ? document.fonts.load('64px "Libre Caslon Display"').catch(function () {}) : null
    ]).then(function (res) {
      var src = res[0], d = dims(src);
      var cv = document.createElement('canvas');
      cv.width = 1200; cv.height = 630;
      var x = cv.getContext('2d');
      x.fillStyle = c.color || '#1b3fd0';
      x.fillRect(0, 0, 1200, 630);
      var h = 510, w = Math.min(560, d.w * h / d.h);
      h = w * d.h / d.w;
      var left = 70, top = (630 - h) / 2;
      x.shadowColor = 'rgba(0,0,0,.35)'; x.shadowBlur = 30; x.shadowOffsetY = 12;
      x.imageSmoothingQuality = 'high';
      x.drawImage(src, left, top, w, h);
      x.shadowColor = 'transparent';
      x.fillStyle = c.ink || '#fff';
      var tx = left + w + 60, maxW = 1200 - tx - 60;
      if (c.eyebrow) { x.font = '500 22px "Albert Sans", sans-serif'; x.fillText(c.eyebrow.toUpperCase(), tx, 250, maxW); }
      x.font = '64px "Libre Caslon Display", Georgia, serif';
      wrap(x, c.title || book.title || '', tx, 330, maxW, 70);
      if (src.close) src.close();
      return new Promise(function (resolve) { cv.toBlob(resolve, 'image/jpeg', 0.86); });
    }).catch(function () { return null; });
  }
  function wrap(x, text, left, top, maxW, lh) {
    var line = '', y = top;
    text.split(/\s+/).forEach(function (word) {
      var test = line ? line + ' ' + word : word;
      if (x.measureText(test).width > maxW && line) { x.fillText(line, left, y); line = word; y += lh; }
      else line = test;
    });
    if (line) x.fillText(line, left, y);
  }

  function b64ToText(b64) {
    var bin = atob(b64.replace(/\n/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, function (ch) { return ch.charCodeAt(0); }));
  }

  function saveOnline() {
    if (!titlesOk()) { setMode(true); return; }
    var s = ghSettings();
    (s.repo && s.token ? Promise.resolve(s) : askGh()).then(function (gh) {
      if (!gh) return;
      var btn = $('publish');
      btn.disabled = true;
      btn.textContent = 'Saving…';
      var stamp = new Date().toISOString();
      var site = new URL('../', location.href).href;
      var head, baseTree, existing = {}, uploaded = [];

      ghApi(gh, 'GET', '/git/ref/heads/main').then(function (ref) {
        head = ref.object.sha;
        return ghApi(gh, 'GET', '/git/commits/' + head);
      }).then(function (c) {
        baseTree = c.tree.sha;
        return ghApi(gh, 'GET', '/git/trees/' + baseTree + '?recursive=1');
      }).then(function (tree) {
        tree.tree.forEach(function (t) { existing[t.path] = true; });
        // New image files, uploaded one at a time so a slow connection does not time out.
        var files = [];
        imageNames().forEach(function (n) {
          var e = book.images[n];
          if (!e.local) return;
          [e.src, e.small].forEach(function (path) {
            var f = fileOf(path);
            if (blobs[f] && !(e.saved && existing[path])) files.push({ path: path, blob: blobs[f], name: n });
          });
        });
        var entries = [];
        return files.reduce(function (chain, f, i) {
          return chain.then(function () {
            btn.textContent = 'Saving ' + (i + 1) + '/' + files.length + '…';
            return toBase64(f.blob).then(function (data) {
              return ghApi(gh, 'POST', '/git/blobs', { content: data, encoding: 'base64' });
            }).then(function (b) {
              entries.push({ path: f.path, mode: '100644', type: 'blob', sha: b.sha });
              uploaded.push(f.name);
            });
          });
        }, Promise.resolve()).then(function () { return entries; });
      }).then(function (entries) {
        btn.textContent = 'Saving…';
        removed.forEach(function (path) {
          if (/^images\//.test(path) && existing[path] && !stillUsed(path)) entries.push({ path: path, mode: '100644', type: 'blob', sha: null });
        });
        return ogImage().then(function (og) {
          if (!og) return null;
          return toBase64(og).then(function (data) { return ghApi(gh, 'POST', '/git/blobs', { content: data, encoding: 'base64' }); });
        }).then(function (ogBlob) {
          if (ogBlob) entries.push({ path: 'images/og.jpg', mode: '100644', type: 'blob', sha: ogBlob.sha });
          return ghApi(gh, 'GET', '/contents/index.html?ref=main');
        }).then(function (file) {
          var html = b64ToText(file.content);
          var a = html.indexOf(OG_START), z = html.indexOf(OG_END);
          if (a !== -1 && z > a) {
            entries.push({ path: 'index.html', mode: '100644', type: 'blob', content: html.slice(0, a) + ogBlock(site).trim() + html.slice(z + OG_END.length) });
          }
          book.updated = stamp;
          entries.push({ path: 'book.json', mode: '100644', type: 'blob', content: exportJSON() });
          return ghApi(gh, 'POST', '/git/trees', { base_tree: baseTree, tree: entries });
        });
      }).then(function (tree) {
        return ghApi(gh, 'POST', '/git/commits', {
          message: 'Update the book from the Spread editor',
          tree: tree.sha,
          parents: [head]
        });
      }).then(function (c) {
        return ghApi(gh, 'PATCH', '/git/refs/heads/main', { sha: c.sha });
      }).then(function () {
        uploaded.forEach(function (n) { if (book.images[n]) book.images[n].saved = true; });
        removed = [];
        return put('kv', 'draft', { book: book, removed: removed, at: Date.now() });
      }).then(function () {
        location.href = '../?saved=' + encodeURIComponent(stamp);
      }).catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Save';
        var msg = err && err.message === 'Failed to fetch' ? 'Could not reach GitHub. Check your connection and try again.'
          : err && err.status === 401 ? 'GitHub did not accept the token. Paste a new one.'
          : err && (err.status === 403 || err.status === 404) ? 'That token cannot write to ' + gh.repo + '. Check it has Contents: Read and write for that repo.'
          : err && err.status === 422 ? 'The repo changed while saving. Press Save again.'
          : 'Could not save: ' + ((err && err.message) || 'unknown error');
        if (err && err.status === 401) {
          try { localStorage.removeItem('spread-github'); } catch (e) {}
        }
        toast(msg + ' Your draft is safe in this browser.', 12000);
      });
    });
  }

  /* A zip with no compression: images are already compressed, so storing them is enough. */
  var CRC = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function zip(entries) {
    var enc = new TextEncoder();
    return Promise.all(entries.map(function (e) {
      return (typeof e[1] === 'string' ? Promise.resolve(enc.encode(e[1])) : e[1].arrayBuffer().then(function (b) { return new Uint8Array(b); }))
        .then(function (data) { return { name: enc.encode(e[0]), data: data, crc: crc32(data) }; });
    })).then(function (files) {
      var parts = [], central = [], offset = 0;
      var now = new Date();
      var time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
      var date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
      files.forEach(function (f) {
        var lh = new DataView(new ArrayBuffer(30));
        lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
        lh.setUint16(8, 0, true); lh.setUint16(10, time, true); lh.setUint16(12, date, true);
        lh.setUint32(14, f.crc, true); lh.setUint32(18, f.data.length, true); lh.setUint32(22, f.data.length, true);
        lh.setUint16(26, f.name.length, true); lh.setUint16(28, 0, true);
        parts.push(lh, f.name, f.data);
        var ch = new DataView(new ArrayBuffer(46));
        ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
        ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, time, true);
        ch.setUint16(14, date, true); ch.setUint32(16, f.crc, true); ch.setUint32(20, f.data.length, true);
        ch.setUint32(24, f.data.length, true); ch.setUint16(28, f.name.length, true);
        ch.setUint32(42, offset, true);
        central.push(ch, f.name);
        offset += 30 + f.name.length + f.data.length;
      });
      var size = central.reduce(function (s, p) { return s + p.byteLength; }, 0);
      var end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
      end.setUint32(12, size, true); end.setUint32(16, offset, true);
      return new Blob(parts.concat(central, [end]), { type: 'application/zip' });
    });
  }

  function downloadZip() {
    var entries = [['book.json', exportJSON()]].concat(localFiles().map(function (f) { return ['images/' + f[0], f[1]]; }));
    var gone = removed.filter(function (p) { return !stillUsed(p); });
    if (gone.length) entries.push(['DELETE-THESE.txt', 'These image files are no longer in the book. Delete them from the spread folder:\n\n' + gone.join('\n') + '\n']);
    zip(entries).then(function (blob) {
      var a = h('a', { href: URL.createObjectURL(blob), download: 'spread-book.zip' });
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('Backup downloaded: spread-book.zip has book.json and the images added here.', 8000);
    });
  }

  /* ---------- Arrange with AI ---------- */

  var AI_TIMEOUT = 240000;

  function aiSettings() {
    try { return JSON.parse(localStorage.getItem('spread-ai') || 'null') || {}; } catch (e) { return {}; }
  }
  function askSettings() {
    var s = aiSettings();
    $('ai-url').value = s.url || '';
    $('ai-key').value = s.key || '';
    return new Promise(function (resolve) {
      var d = $('ai-dialog');
      d.addEventListener('close', function once() {
        d.removeEventListener('close', once);
        if (d.returnValue !== 'save') return resolve(null);
        var next = { url: $('ai-url').value.trim().replace(/\/+$/, ''), key: $('ai-key').value };
        try { localStorage.setItem('spread-ai', JSON.stringify(next)); } catch (e) {}
        resolve(next);
      });
      d.showModal();
    });
  }

  function toBase64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1]); };
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  // The 1000px copy of each image: made in this browser, or fetched from the published site.
  function smallBlob(name) {
    var e = book.images[name];
    var f = fileOf(e.small || e.src);
    if (e.local && blobs[f]) return Promise.resolve(blobs[f]);
    return fetch(BASE + (e.small || e.src)).then(function (r) {
      if (!r.ok) throw new Error('Could not load ' + name);
      return r.blob();
    });
  }

  function humanText(p) {
    var out = {};
    ['caption', 'note', 'heading', 'body'].forEach(function (k) {
      if (p[k] && !(p.ai && p.ai[k])) out[k] = p[k];
    });
    return out;
  }

  function arrange() {
    var names = imageNames();
    if (!names.length) { toast('Add some images first.'); return; }
    var settings = aiSettings();
    var ready = settings.url && settings.key ? Promise.resolve(settings) : askSettings();
    ready.then(function (s) {
      if (!s) return;
      var btn = $('arrange');
      var progress = $('progress');
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      progress.hidden = false;
      progress.textContent = 'Getting ' + names.length + ' images ready…';
      var started = Date.now();

      Promise.all(names.map(function (n) {
        return smallBlob(n).then(function (b) {
          return toBase64(b).then(function (data) {
            var e = book.images[n];
            var page = book.pages.find(function (p) { return p.image === n; }) || {};
            return { id: n, type: b.type || 'image/webp', width: e.width, height: e.height, data: data, text: humanText(page) };
          });
        });
      })).then(function (images) {
        progress.textContent = 'Claude is looking at your ' + images.length + ' images. This usually takes under a minute.';
        var ctrl = new AbortController();
        var timer = setTimeout(function () { ctrl.abort(); }, AI_TIMEOUT);
        return fetch(s.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Spread-Key': s.key },
          body: JSON.stringify({ images: images, context: { artist: book.cover.eyebrow || '', title: book.cover.title || '' } }),
          signal: ctrl.signal
        }).then(function (r) {
          clearTimeout(timer);
          return r.json().catch(function () { return {}; }).then(function (body) {
            if (r.status === 401) {
              try { localStorage.removeItem('spread-ai'); } catch (e) {}
              throw new Error('The passphrase was not accepted. Check it under AI settings.');
            }
            if (!r.ok || !body.plan) throw new Error(body.error || 'Something went wrong (' + r.status + ').');
            return body;
          });
        });
      }).then(function (res) {
        applyPlan(res.plan);
        var secs = Math.round((Date.now() - started) / 1000);
        var titles = book.pages.filter(function (p) { return p.ai && p.ai.caption; }).length;
        toast('Arranged by Claude in ' + secs + 's.' + (titles ? ' ' + (titles === 1 ? 'Its title is a suggestion' : 'Its ' + titles + ' titles are suggestions') + ': check them under Edit book.' : '') + ' Undo puts everything back.', 12000);
      }).catch(function (err) {
        var msg = err && err.name === 'AbortError' ? 'Claude took too long. Try again, or with fewer images.'
          : err && err.message === 'Failed to fetch' ? 'Could not reach the AI Worker. Check the address under AI settings.'
          : (err && err.message) || 'Something went wrong.';
        toast(msg, 10000);
      }).then(function () {
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
        progress.hidden = true;
      });
    });
  }

  // Claude's plan replaces the order and layouts. Text you wrote wins over its suggestions;
  // everything it fills in is flagged so the editor can mark it.
  function applyPlan(plan) {
    commit(function () {
      var known = book.images;
      var seen = {};
      var old = {};
      book.pages.forEach(function (p) { if (p.image && !old[p.image]) old[p.image] = p; });

      function fill(page, key, value, prior) {
        if (prior && prior[key] && !(prior.ai && prior.ai[key])) { page[key] = prior[key]; return; }
        if (!value) return;
        page[key] = value;
        (page.ai = page.ai || {})[key] = true;
      }

      var imagePages = [];
      (plan.pages || []).forEach(function (pp) {
        if (!known[pp.image] || seen[pp.image]) return;
        seen[pp.image] = true;
        var wide = known[pp.image].width / known[pp.image].height > 1.15;
        var layout = pp.layout === 'spread' && !wide ? 'plate' : pp.layout;
        var page = { layout: layout, image: pp.image };
        var prior = old[pp.image];
        // Only fill what the layout shows: full-page and across-the-fold pieces carry no caption.
        if (layout === 'half') {
          fill(page, 'heading', pp.heading, prior);
          fill(page, 'body', pp.body, prior);
        } else if (layout === 'plate') {
          fill(page, 'caption', pp.title_suggestion, prior);
          fill(page, 'note', pp.note, prior);
        }
        fill(page, 'alt', pp.alt, prior);
        if (layout === 'bleed' || layout === 'half') page.focus = pp.focus || '50% 50%';
        imagePages.push(page);
      });
      // Anything Claude skipped keeps a plain page at the end.
      imageNames().forEach(function (n) { if (!seen[n]) imagePages.push({ layout: 'plate', image: n }); });

      var intro = book.pages.find(function (p) { return p.layout === 'text'; });
      var introPage = { layout: 'text' };
      ['eyebrow', 'heading', 'body'].forEach(function (k) { fill(introPage, k, plan.intro && plan.intro[k], intro); });
      var rest = book.pages.filter(function (p) { return !p.image && p !== intro && p.layout !== 'endpaper'; });

      book.pages = [{ layout: 'endpaper' }, introPage].concat(imagePages, rest, [{ layout: 'endpaper' }]);
      fixSpreads();

      var c = plan.cover || {};
      if (known[c.image]) book.cover.image = c.image;
      if (c.color) book.cover.color = c.color;
      if (c.ink) book.cover.ink = c.ink;
      if (c.endpaper) book.endpaper = c.endpaper;
      if (Spread.surfaces.indexOf(c.surface) !== -1) book.surface = c.surface;
      if (c.subtitle && (!book.cover.subtitle || (book.cover.ai && book.cover.ai.subtitle))) {
        book.cover.subtitle = c.subtitle;
        (book.cover.ai = book.cover.ai || {}).subtitle = true;
      }
    });
    currentPage = 0;
    renderPreview();
  }

  // A spread must open on a left-hand page: pull the next single image in front of it,
  // or add a blank page if there is none.
  function fixSpreads() {
    for (var i = 0; i < book.pages.length; i++) {
      var p = book.pages[i];
      if (p.layout !== 'spread' || startOf(i) % 2 === 1) continue;
      var j = -1;
      for (var k = i + 1; k < book.pages.length; k++) {
        if (book.pages[k].image && book.pages[k].layout !== 'spread') { j = k; break; }
      }
      if (j !== -1) book.pages.splice(i, 0, book.pages.splice(j, 1)[0]);
      else book.pages.splice(i, 0, { layout: 'endpaper' });
    }
  }

  function setMode(editing) {
    document.body.classList.toggle('is-simple', !editing);
    $('mode').textContent = editing ? 'Done editing' : 'Edit book';
    $('mode').setAttribute('aria-pressed', String(editing));
    try { localStorage.setItem('spread-mode', editing ? 'edit' : 'simple'); } catch (e) {}
  }

  /* ---------- wiring ---------- */

  $('arrange').addEventListener('click', arrange);
  $('ai-settings').addEventListener('click', function () { askSettings(); });
  $('mode').addEventListener('click', function () { setMode(document.body.classList.contains('is-simple')); });
  try { setMode(localStorage.getItem('spread-mode') === 'edit'); } catch (e) { setMode(false); }

  $('file').addEventListener('change', function (e) { addFiles(e.target.files); e.target.value = ''; });
  var drop = $('drop');
  ['dragenter', 'dragover'].forEach(function (t) {
    document.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('is-over'); });
  });
  ['dragleave', 'drop'].forEach(function (t) {
    document.addEventListener(t, function (e) {
      e.preventDefault();
      if (t === 'drop' || e.target === document.documentElement) drop.classList.remove('is-over');
    });
  });
  document.addEventListener('drop', function (e) { if (e.dataTransfer) addFiles(e.dataTransfer.files); });

  $('undo').addEventListener('click', undo);
  document.addEventListener('keydown', function (e) {
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'z' && !typing) { e.preventDefault(); undo(); }
  });
  $('reset').addEventListener('click', function () {
    if (!confirm('Start over from the published book? This clears the draft and any images added here that you have not published.')) return;
    Promise.all([clear('kv'), clear('files')]).then(loadLive).then(function () { currentPage = 0; render(); toast('Back to the published book.'); });
  });
  $('publish').addEventListener('click', saveOnline);
  $('gh-settings').addEventListener('click', function () { askGh(); });
  $('zip').addEventListener('click', downloadZip);
  document.querySelectorAll('[data-add]').forEach(function (b) {
    b.addEventListener('click', function () {
      var kind = b.getAttribute('data-add');
      commit(function () { book.pages.push(kind === 'text' ? { layout: 'text', heading: 'New page' } : { layout: 'endpaper' }); });
    });
  });

  loadDraft().then(function (had) { return had ? null : loadLive(); }).then(render).catch(function (err) {
    console.error(err);
    toast('Could not load the book.', 8000);
  });
})();
