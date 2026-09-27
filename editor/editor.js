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
    image: 'Image', caption: 'Caption', note: 'Note', alt: 'Description (for screen readers)',
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
  function textField(obj, key, label, multiline) {
    var input = h(multiline ? 'textarea' : 'input', {
      class: 'input', rows: multiline ? 3 : false, type: multiline ? false : 'text',
      onfocus: function () { history.push(snapshot()); $('undo').disabled = false; },
      oninput: function () { obj[key] = input.value; save(); schedulePreview(); }
    });
    input.value = obj[key] || '';
    return h('label', { class: 'field' }, [h('span', { text: label }), input]);
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
    Object.keys(out.images).forEach(function (n) { delete out.images[n].local; });
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

  function publish() {
    if (!window.showDirectoryPicker) { downloadZip(); return; }
    var dir, written = 0, deleted = 0;
    window.showDirectoryPicker({ id: 'spread-repo', mode: 'readwrite' }).then(function (d) {
      dir = d;
      return dir.getFileHandle('spread.js').catch(function () {
        throw new Error('That folder is not the spread repo. Choose Documents/GitHub/spread.');
      });
    }).then(function () {
      return dir.getDirectoryHandle('images', { create: true });
    }).then(function (imgDir) {
      var writes = localFiles().map(function (f) {
        return imgDir.getFileHandle(f[0], { create: true }).then(function (fh) { return fh.createWritable(); })
          .then(function (w) { return w.write(f[1]).then(function () { written++; return w.close(); }); });
      });
      var deletes = removed.filter(function (p) { return /^images\//.test(p) && !stillUsed(p); }).map(function (p) {
        return imgDir.removeEntry(fileOf(p)).then(function () { deleted++; }).catch(function () {});
      });
      return Promise.all(writes.concat(deletes));
    }).then(function () {
      return dir.getFileHandle('book.json', { create: true });
    }).then(function (fh) { return fh.createWritable(); })
      .then(function (w) { return w.write(exportJSON()).then(function () { return w.close(); }); })
      .then(function () {
        commit(function () { removed = []; });
        toast('Saved to your spread folder: book.json, ' + written + ' image files written' +
          (deleted ? ', ' + deleted + ' old ones removed' : '') +
          '. Now commit and push in GitHub Desktop; it goes live in a minute or two.', 12000);
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return;
        toast(err && err.message ? err.message : 'Could not save to that folder.', 8000);
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
      toast('Downloaded spread-book.zip. Unzip it into your spread folder (replace book.json), then commit and push.', 10000);
    });
  }

  /* ---------- wiring ---------- */

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
  $('publish').addEventListener('click', publish);
  $('zip').addEventListener('click', downloadZip);
  document.querySelectorAll('[data-add]').forEach(function (b) {
    b.addEventListener('click', function () {
      var kind = b.getAttribute('data-add');
      commit(function () { book.pages.push(kind === 'text' ? { layout: 'text', heading: 'New page' } : { layout: 'endpaper' }); });
    });
  });
  if (!window.showDirectoryPicker) $('publish').title = 'This browser cannot save into a folder, so Publish downloads a zip.';

  loadDraft().then(function (had) { return had ? null : loadLive(); }).then(render).catch(function (err) {
    console.error(err);
    toast('Could not load the book.', 8000);
  });
})();
