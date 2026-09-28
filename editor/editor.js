/*
 * Spread editor. Builds book.json and web-size images entirely in the browser.
 * Nothing is uploaded: the draft (book + resized image files) lives in IndexedDB until
 * Publish writes it into the spread folder (Chrome/Edge) or a zip is downloaded.
 */
(function () {
  'use strict';

  var MAX_IMAGES = 30;
  // A page is at most 600px wide on screen (1200px across a spread), so 1800px covers a Retina
  // display for single pages and 2400px for pieces that run across both.
  // Each file gets a size budget: quality steps down gently until it fits, never below the floor.
  var BIG = { edge: 1800, wideEdge: 2400, quality: 0.84, floor: 0.66, budget: 450 * 1024 };
  var SMALL = { edge: 1000, quality: 0.8, floor: 0.62, budget: 140 * 1024 };
  var WIDE = 1.15;
  // ?book=<slug> edits that book; without it the editor shows the list of books.
  var SLUG = new URLSearchParams(location.search).get('book') || '';
  var BASE = '../' + (SLUG ? SLUG + '/' : '');
  var SITE = new URL('../', location.href).href;
  var RESERVED = ['editor', 'template', 'vendor', 'tools', 'ai-worker', 'images', 'source-images', 'books', 'index', 'page', 'spread', 'favicon', 'assets'];

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
  var del = function (store, key) { return idb(store, 'readwrite', function (s) { return s.delete(key); }); };
  var keys = function (store) { return idb(store, 'readonly', function (s) { return s.getAllKeys(); }).then(function (k) { return k || []; }); };
  // Remove every key in a store that starts with prefix (one book's files).
  function delPrefix(store, prefix) {
    return keys(store).then(function (all) {
      return Promise.all(all.filter(function (k) { return String(k).indexOf(prefix) === 0; }).map(function (k) { return del(store, k); }));
    });
  }

  // Each book keeps its own draft and image files.
  function draftKey(slug) { return 'draft:' + (slug || SLUG); }
  function fileKey(f, slug) { return (slug || SLUG) + '/' + f; }

  // Before books had folders, the one draft lived under 'draft' with bare file names.
  // It belongs to the first book, Selected Works.
  var LEGACY_SLUG = 'selected-works';
  function migrateLegacy() {
    return get('kv', 'draft').then(function (d) {
      if (!d) return;
      return get('kv', draftKey(LEGACY_SLUG)).then(function (existing) {
        if (existing) return del('kv', 'draft');
        return keys('files').then(function (all) {
          var bare = all.filter(function (k) { return String(k).indexOf('/') === -1; });
          return Promise.all(bare.map(function (k) {
            return get('files', k).then(function (b) { return put('files', fileKey(k, LEGACY_SLUG), b); }).then(function () { return del('files', k); });
          }));
        }).then(function () {
          d.dirty = true;  // old drafts did not record whether they had been saved
          return put('kv', draftKey(LEGACY_SLUG), d);
        }).then(function () { return del('kv', 'draft'); });
      });
    });
  }

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
    saveTimer = setTimeout(function () { put('kv', draftKey(), { book: book, removed: removed, at: Date.now(), dirty: true }); }, 250);
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
  // Where an image's published file lives. A duplicated book reads its images from the book it
  // was copied from (copyOf holds repo paths) until the first Save copies them across.
  function remoteUrl(e, key) {
    var k = key === 'small' && !e.small ? 'src' : key;
    return e.copyOf ? SITE + e.copyOf[k] : new URL(BASE + e[k], location.href).href;
  }
  function thumbUrl(name) {
    var e = book.images[name];
    if (!e) return '';
    return (e.local && localUrl(fileOf(e.small || e.src))) || remoteUrl(e, 'small');
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
    var bookReq = fetch(BASE + 'book.json', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('This book is not online yet.');
      return r.json();
    });
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
    return get('kv', draftKey()).then(function (d) {
      if (!d || !d.book) return false;
      book = d.book;
      removed = d.removed || [];
      var local = [];
      imageNames().forEach(function (n) {
        var e = book.images[n];
        if (e.local) local.push(fileOf(e.src), fileOf(e.small));
      });
      return Promise.all(local.map(function (f) {
        return get('files', fileKey(f)).then(function (b) { if (b) blobs[f] = b; });
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

  function encodeAt(canvas, type, quality) {
    return new Promise(function (resolve) { canvas.toBlob(resolve, type, quality); });
  }
  // WebP where the browser can write it (older Safari falls back to JPEG), stepping quality
  // down until the file fits its budget.
  function encode(canvas, spec) {
    return encodeAt(canvas, 'image/webp', spec.quality).then(function (first) {
      var type = first && first.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
      var q = spec.quality;
      function fit(blob) {
        if (blob && blob.size <= spec.budget) return blob;
        if (q - 0.06 < spec.floor) return blob;
        q = Math.round((q - 0.06) * 100) / 100;
        return encodeAt(canvas, type, q).then(fit);
      }
      return type === 'image/webp' ? fit(first) : encodeAt(canvas, type, q).then(fit);
    });
  }
  function extOf(type) { return { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' }[type] || 'webp'; }
  function mb(bytes) { return bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB'; }

  function processFile(file) {
    return decode(file).then(function (src) {
      var d = dims(src);
      var bigCanvas = resize(src, d.w / d.h > WIDE ? BIG.wideEdge : BIG.edge);
      var smallCanvas = resize(src, SMALL.edge);
      return Promise.all([encode(bigCanvas, BIG), encode(smallCanvas, SMALL)]).then(function (out) {
        if (src.close) src.close();
        return {
          big: out[0], small: out[1],
          width: bigCanvas.width, height: bigCanvas.height,
          smallWidth: smallCanvas.width, smallHeight: smallCanvas.height
        };
      });
    });
  }

  // Store a processed image as this browser's copy of `name`, replacing any earlier files.
  function storeImage(name, r, extra) {
    var bigFile = name + '.' + extOf(r.big.type);
    var smallFile = name + '-1000.' + extOf(r.small.type);
    blobs[bigFile] = r.big;
    blobs[smallFile] = r.small;
    delete urls[bigFile];
    delete urls[smallFile];
    return Promise.all([put('files', fileKey(bigFile), r.big), put('files', fileKey(smallFile), r.small)]).then(function () {
      var entry = {
        src: 'images/' + bigFile, small: 'images/' + smallFile,
        width: r.width, height: r.height, smallWidth: r.smallWidth,
        bytes: r.big.size, local: true
      };
      Object.keys(extra || {}).forEach(function (k) { entry[k] = extra[k]; });
      return entry;
    });
  }

  function showResizeNote(count, before, after) {
    var note = $('resize-note');
    note.hidden = false;
    note.textContent = 'Resized ' + count + (count === 1 ? ' image' : ' images') + ' for the web: ' +
      mb(before) + ' → ' + mb(after) + '.';
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
    var made = [], failed = [], before = 0, after = 0;

    files.reduce(function (chain, file, i) {
      return chain.then(function () {
        progress.textContent = 'Resizing ' + (i + 1) + ' of ' + files.length + ': ' + file.name;
        return processFile(file).then(function (r) {
          var name = uniqueName(slug(file.name));
          return storeImage(name, r).then(function (entry) {
            before += file.size;
            after += r.big.size;
            made.push({ name: name, entry: entry });
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
        showResizeNote(made.length, before, after);
      }
      var msg = made.length ? 'Added and resized ' + made.length + (made.length === 1 ? ' image' : ' images') +
        ': ' + mb(before) + ' → ' + mb(after) + '.' : '';
      if (skipped > 0) msg += ' ' + skipped + ' not added: the limit is 30.';
      if (failed.length) msg += ' Could not read ' + failed.join(', ') + '. Try exporting it as JPEG.';
      toast(msg.trim(), 8000);
    });
  }

  /* ---------- Lighten images already in the book ---------- */

  var published = {};   // image name -> bytes of its published large file

  // Ask the site how big each published image is (a HEAD request moves no image data).
  function measurePublished() {
    return Promise.all(imageNames().map(function (n) {
      var e = book.images[n];
      if (e.local) return null;
      return fetch(remoteUrl(e, 'src'), { method: 'HEAD', cache: 'no-store' }).then(function (r) {
        var len = Number(r.headers.get('Content-Length'));
        if (r.ok && len) published[n] = len;
      }).catch(function () {});
    })).then(function () { renderTray(); renderLighten(); });
  }

  function sizeOf(name) {
    var e = book.images[name];
    return e.local ? (e.bytes || (blobs[fileOf(e.src)] || {}).size || 0) : published[name] || e.bytes || 0;
  }

  function heavyImages() {
    return imageNames().filter(function (n) { return sizeOf(n) > BIG.budget * 1.1; });
  }

  function renderLighten() {
    var box = $('lighten');
    var heavy = heavyImages();
    if (!heavy.length) { box.hidden = true; return; }
    var total = heavy.reduce(function (t, n) { return t + sizeOf(n); }, 0);
    box.hidden = false;
    $('lighten-text').textContent = heavy.length + (heavy.length === 1 ? ' image is' : ' images are') +
      ' heavier than the book needs (' + mb(total) + ' together), so the book loads slowly.';
  }

  function lighten() {
    var heavy = heavyImages();
    if (!heavy.length) return;
    var btn = $('lighten-btn');
    btn.disabled = true;
    var progress = $('progress');
    progress.hidden = false;
    var done = [], before = 0, after = 0;
    heavy.reduce(function (chain, name, i) {
      return chain.then(function () {
        progress.textContent = 'Making lighter ' + (i + 1) + ' of ' + heavy.length + ': ' + name;
        var e = book.images[name];
        var src = e.local && blobs[fileOf(e.src)] ? Promise.resolve(blobs[fileOf(e.src)])
          : fetch(remoteUrl(e, 'src'), { cache: 'no-store' }).then(function (r) { return r.blob(); });
        return src.then(function (blob) {
          before += sizeOf(name);
          return processFile(blob);
        }).then(function (r) {
          return storeImage(name, r).then(function (entry) {
            after += r.big.size;
            done.push({ name: name, entry: entry, old: [e.src, e.small] });
          });
        }).catch(function () {});
      });
    }, Promise.resolve()).then(function () {
      progress.hidden = true;
      btn.disabled = false;
      if (!done.length) { toast('Could not make those images lighter. Try again.'); return; }
      commit(function () {
        done.forEach(function (d) {
          book.images[d.name] = Object.assign({}, book.images[d.name], d.entry, { saved: false });
          // A published file whose name changed (say .jpg to .webp) is deleted on Save.
          d.old.forEach(function (p) { if (p && p !== d.entry.src && p !== d.entry.small) removed.push(p); });
          delete published[d.name];
        });
      });
      showResizeNote(done.length, before, after);
      toast('Made ' + done.length + (done.length === 1 ? ' image' : ' images') + ' lighter: ' + mb(before) + ' → ' + mb(after) +
        '. Press Save to put them online.', 10000);
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

  function checkField(obj, key, label, dflt) {
    var box = h('input', { type: 'checkbox', onchange: function () { commit(function () { obj[key] = box.checked; }); } });
    box.checked = obj[key] === undefined ? dflt : !!obj[key];
    return h('label', { class: 'field field--check' }, [box, h('span', { text: label })]);
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
        e.local && !e.saved ? h('span', { class: 'thumb-tag', text: 'new' }) : null,
        sizeOf(name) ? h('span', { class: 'thumb-size' + (sizeOf(name) > BIG.budget * 1.1 ? ' is-heavy' : ''), text: mb(sizeOf(name)) }) : null
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
      textField(book, 'title', 'Book name (read out by screen readers)'),
      checkField(book, 'listed', 'Show this book on my shelf', true)
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
      if (e.copyOf && !e.local) {
        e.src = remoteUrl(e, 'src');
        e.small = remoteUrl(e, 'small');
        return;
      }
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
    renderLighten();
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
    Object.keys(out.images).forEach(function (n) { ['local', 'saved', 'bytes', 'copyOf'].forEach(function (k) { delete out.images[n][k]; }); });
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

  // One commit on top of main. build(tree) receives { path: sha } for every file in the repo
  // and returns the tree entries to change.
  function ghCommit(gh, message, build) {
    var head, baseTree;
    return ghApi(gh, 'GET', '/git/ref/heads/main').then(function (ref) {
      head = ref.object.sha;
      return ghApi(gh, 'GET', '/git/commits/' + head);
    }).then(function (c) {
      baseTree = c.tree.sha;
      return ghApi(gh, 'GET', '/git/trees/' + baseTree + '?recursive=1');
    }).then(function (tree) {
      var existing = {};
      tree.tree.forEach(function (t) { if (t.type === 'blob') existing[t.path] = t.sha; });
      return build(existing);
    }).then(function (entries) {
      return ghApi(gh, 'POST', '/git/trees', { base_tree: baseTree, tree: entries });
    }).then(function (tree) {
      return ghApi(gh, 'POST', '/git/commits', { message: message, tree: tree.sha, parents: [head] });
    }).then(function (c) {
      return ghApi(gh, 'PATCH', '/git/refs/heads/main', { sha: c.sha });
    });
  }

  function ghError(err, gh) {
    if (err && err.status === 401) { try { localStorage.removeItem('spread-github'); } catch (e) {} }
    return err && err.message === 'Failed to fetch' ? 'Could not reach GitHub. Check your connection and try again.'
      : err && err.status === 401 ? 'GitHub did not accept the token. Paste a new one.'
      : err && (err.status === 403 || err.status === 404) ? 'That token cannot write to ' + gh.repo + '. Check it has Contents: Read and write for that repo.'
      : err && err.status === 422 ? 'The repo changed while saving. Try again.'
      : 'Could not save: ' + ((err && err.message) || 'unknown error');
  }

  function withGh() {
    var s = ghSettings();
    return s.repo && s.token ? Promise.resolve(s) : askGh();
  }

  function readShelf(gh) {
    return ghApi(gh, 'GET', '/contents/books.json?ref=main').then(function (f) {
      return JSON.parse(b64ToText(f.content));
    }).catch(function (err) {
      if (err && err.status === 404) return { books: [] };
      throw err;
    });
  }

  function shelfEntry() {
    var c = book.cover || {};
    var img = book.images[c.image];
    return {
      slug: SLUG,
      title: c.title || book.title || SLUG,
      eyebrow: c.eyebrow || '',
      color: c.color || '#1b3fd0',
      ink: c.ink || '#ffffff',
      cover: img ? SLUG + '/' + (img.small || img.src) : '',
      pages: book.pages.length,
      listed: book.listed !== false,
      updated: book.updated
    };
  }

  // GitHub Pages takes about a minute to publish. A brand-new book's page does not exist until
  // then, so wait here and open the book once its new book.json is being served.
  function waitUntilLive(stamp) {
    var panel = $('publishing');
    panel.hidden = false;
    var started = Date.now();
    var target = '../' + SLUG + '/?saved=' + encodeURIComponent(stamp);
    $('publishing-open').href = target;
    function poll() {
      fetch(BASE + 'book.json?v=' + Date.now(), { cache: 'no-store' }).then(function (r) {
        return r.ok ? r.json() : null;
      }).then(function (cfg) {
        if (cfg && cfg.updated && cfg.updated >= stamp) { location.href = target; return; }
        later();
      }).catch(later);
    }
    function later() {
      if (Date.now() - started < 5 * 60 * 1000) setTimeout(poll, 4000);
      else $('publishing-text').textContent = 'Saved. It is taking longer than usual to go live; open the book in a few minutes.';
    }
    poll();
  }

  function saveOnline() {
    if (!titlesOk()) { setMode(true); return; }
    withGh().then(function (gh) {
      if (!gh) return;
      var btn = $('publish');
      btn.disabled = true;
      btn.textContent = 'Saving…';
      var stamp = new Date().toISOString();
      var site = SITE + SLUG + '/';
      var uploaded = [];
      var at = function (path) { return SLUG + '/' + path; };

      ghCommit(gh, 'Save "' + ((book.cover && book.cover.title) || SLUG) + '" from the Spread editor', function (existing) {
        var entries = [];
        // Images made in this browser, uploaded one at a time so a slow connection does not time out.
        var files = [];
        imageNames().forEach(function (n) {
          var e = book.images[n];
          if (e.local) {
            [e.src, e.small].forEach(function (path) {
              var f = fileOf(path);
              if (blobs[f] && !(e.saved && existing[at(path)])) files.push({ path: path, blob: blobs[f], name: n });
            });
          } else if (e.copyOf) {
            // Copied from another book: point the new path at the same stored file, no upload.
            ['src', 'small'].forEach(function (k) {
              var sha = e.copyOf[k] && existing[e.copyOf[k]];
              if (sha && e[k]) entries.push({ path: at(e[k]), mode: '100644', type: 'blob', sha: sha });
            });
          }
        });
        return files.reduce(function (chain, f, i) {
          return chain.then(function () {
            btn.textContent = 'Saving ' + (i + 1) + '/' + files.length + '…';
            return toBase64(f.blob).then(function (data) {
              return ghApi(gh, 'POST', '/git/blobs', { content: data, encoding: 'base64' });
            }).then(function (b) {
              entries.push({ path: at(f.path), mode: '100644', type: 'blob', sha: b.sha });
              uploaded.push(f.name);
            });
          });
        }, Promise.resolve()).then(function () {
          btn.textContent = 'Saving…';
          removed.forEach(function (path) {
            if (/^images\//.test(path) && existing[at(path)] && !stillUsed(path)) entries.push({ path: at(path), mode: '100644', type: 'blob', sha: null });
          });
          return ogImage();
        }).then(function (og) {
          if (!og) return null;
          return toBase64(og).then(function (data) { return ghApi(gh, 'POST', '/git/blobs', { content: data, encoding: 'base64' }); });
        }).then(function (ogBlob) {
          if (ogBlob) entries.push({ path: at('images/og.jpg'), mode: '100644', type: 'blob', sha: ogBlob.sha });
          // The book's page comes from the site's template, with this book's title and preview picture.
          return fetch('../template/book.html', { cache: 'no-store' }).then(function (r) {
            if (!r.ok) throw new Error('Could not load the page template.');
            return r.text();
          });
        }).then(function (html) {
          var a = html.indexOf(OG_START), z = html.indexOf(OG_END);
          entries.push({ path: at('index.html'), mode: '100644', type: 'blob',
            content: html.slice(0, a) + ogBlock(site).trim() + html.slice(z + OG_END.length) });
          book.updated = stamp;
          entries.push({ path: at('book.json'), mode: '100644', type: 'blob', content: exportJSON() });
          return readShelf(gh);
        }).then(function (shelf) {
          var entry = shelfEntry();
          shelf.books = (shelf.books || []).filter(function (b) { return b.slug !== SLUG; }).concat([entry]);
          entries.push({ path: 'books.json', mode: '100644', type: 'blob', content: JSON.stringify(shelf, null, 2) + '\n' });
          return entries;
        });
      }).then(function () {
        uploaded.forEach(function (n) { if (book.images[n]) book.images[n].saved = true; });
        imageNames().forEach(function (n) { delete book.images[n].copyOf; });
        removed = [];
        return put('kv', draftKey(), { book: book, removed: removed, at: Date.now(), dirty: false });
      }).then(function () {
        waitUntilLive(stamp);
      }).catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Save';
        toast(ghError(err, gh) + ' Your draft is safe in this browser.', 12000);
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
    return fetch(remoteUrl(e, 'small')).then(function (r) {
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
  $('lighten-btn').addEventListener('click', lighten);
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
    if (!confirm('Start over from the published version of this book? This clears this book\'s draft and any images added here that you have not saved.')) return;
    loadLive().then(function () {
      return Promise.all([delPrefix('files', SLUG + '/'), del('kv', draftKey())]);
    }).then(function () { currentPage = 0; render(); measurePublished(); toast('Back to the published book.'); })
      .catch(function () { toast('This book is not online yet, so there is no saved version to go back to. Your draft is unchanged.', 8000); });
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

  /* ---------- My books ---------- */

  function blankBook(title, eyebrow) {
    return {
      title: [eyebrow, title].filter(Boolean).join(', '),
      page: { width: 600, height: 800 },
      surface: 'studio',
      cover: { eyebrow: eyebrow || '', title: title, subtitle: '', color: '#1b3fd0', ink: '#ffffff' },
      endpaper: '#e8331f',
      back: { text: 'spread.irina.love' },
      listed: true,
      pages: [{ layout: 'endpaper' }, { layout: 'text', heading: title }, { layout: 'endpaper' }],
      images: {}
    };
  }

  function slugify(t) {
    return t.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  }

  var library = { shelf: { books: [] }, drafts: {} };

  function loadLibrary() {
    var shelfReq = fetch('../books.json?v=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : { books: [] }; }).catch(function () { return { books: [] }; });
    var draftReq = keys('kv').then(function (all) {
      var slugs = all.map(String).filter(function (k) { return k.indexOf('draft:') === 0; }).map(function (k) { return k.slice(6); });
      return Promise.all(slugs.map(function (sl) { return get('kv', draftKey(sl)).then(function (d) { return [sl, d]; }); }));
    });
    return Promise.all([shelfReq, draftReq]).then(function (res) {
      library.shelf = res[0];
      library.drafts = {};
      res[1].forEach(function (pair) { if (pair[1] && pair[1].book) library.drafts[pair[0]] = pair[1]; });
    });
  }

  function takenSlugs() {
    return (library.shelf.books || []).map(function (b) { return b.slug; }).concat(Object.keys(library.drafts));
  }

  function coverThumb(slug, draft, pub) {
    var b = draft && draft.book;
    var e = b && b.cover && b.images && b.images[b.cover.image];
    if (e && e.local) {
      return get('files', fileKey(fileOf(e.small || e.src), slug)).then(function (blob) { return blob ? URL.createObjectURL(blob) : null; });
    }
    if (e && e.copyOf) return Promise.resolve(SITE + (e.copyOf.small || e.copyOf.src));
    if (e) return Promise.resolve(SITE + slug + '/' + (e.small || e.src));
    return Promise.resolve(pub && pub.cover ? SITE + pub.cover : null);
  }

  function renderLibrary() {
    var grid = $('books');
    grid.innerHTML = '';
    var pubs = {};
    (library.shelf.books || []).forEach(function (b) { pubs[b.slug] = b; });
    var slugs = Object.keys(pubs).concat(Object.keys(library.drafts).filter(function (sl) { return !pubs[sl]; }));
    slugs.sort(function (a, b) {
      var ta = (library.drafts[a] && library.drafts[a].at) || Date.parse((pubs[a] || {}).updated || 0) || 0;
      var tb = (library.drafts[b] && library.drafts[b].at) || Date.parse((pubs[b] || {}).updated || 0) || 0;
      return tb - ta;
    });
    $('books-empty').hidden = slugs.length > 0;
    slugs.forEach(function (sl) {
      var pub = pubs[sl], draft = library.drafts[sl];
      var c = (draft && draft.book.cover) || {};
      var title = c.title || (pub && pub.title) || sl;
      var status = !pub ? 'Not online yet' : draft && draft.dirty ? 'Online · unsaved changes' : 'Online';
      if (pub && pub.listed === false) status += ' · not on shelf';
      var cover = h('div', { class: 'lib-cover' }, [h('span', { text: title })]);
      cover.style.background = c.color || (pub && pub.color) || '#1b3fd0';
      cover.style.color = c.ink || (pub && pub.ink) || '#fff';
      coverThumb(sl, draft, pub).then(function (u) {
        if (u) cover.insertBefore(h('img', { src: u, alt: '' }), cover.firstChild);
      });
      grid.appendChild(h('li', { class: 'lib-card' }, [
        h('a', { href: '?book=' + encodeURIComponent(sl), class: 'lib-open' }, [
          cover,
          h('p', { class: 'lib-title', text: title }),
          h('p', { class: 'lib-status' + (pub ? '' : ' is-draft'), text: status })
        ]),
        h('div', { class: 'lib-actions' }, [
          pub ? h('a', { class: 'link', href: '../' + sl + '/', text: 'View' }) : null,
          h('button', { type: 'button', class: 'link', text: 'Duplicate', onclick: function () { newBook(sl, title); } }),
          h('button', { type: 'button', class: 'link lib-delete', text: 'Delete', onclick: function () { deleteBook(sl, title, !!pub); } })
        ])
      ]));
    });
  }

  // Ask for a title and web address; resolves { title, slug } or null.
  function askNewBook(heading, title) {
    var d = $('new-dialog');
    $('new-heading').textContent = heading;
    $('new-title').value = title || '';
    $('new-slug').value = slugify(title || '');
    $('new-error').textContent = '';
    var slugEdited = false;
    $('new-slug').oninput = function () { slugEdited = true; };
    $('new-title').oninput = function () { if (!slugEdited) $('new-slug').value = slugify($('new-title').value); };
    return new Promise(function (resolve) {
      var settled = false;
      function finish(value) {
        if (settled) return;
        settled = true;
        if (d.open) d.close();
        resolve(value);
      }
      // Resolve from the buttons themselves rather than the dialog's close event, which some
      // browsers deliver late or not at all for a page in the background.
      $('new-create').onclick = function (e) {
        e.preventDefault();
        var t = $('new-title').value.trim();
        var sl = slugify($('new-slug').value || t);
        var err = !t ? 'Give the book a title.'
          : !sl ? 'The address needs at least one letter or number.'
          : RESERVED.indexOf(sl) !== -1 ? '"' + sl + '" is used by the site itself. Choose another address.'
          : takenSlugs().indexOf(sl) !== -1 ? 'You already have a book at /' + sl + '. Choose another address.'
          : '';
        if (err) { $('new-error').textContent = err; return; }
        finish({ title: t, slug: sl });
      };
      $('new-cancel').onclick = function (e) { e.preventDefault(); finish(null); };
      d.addEventListener('close', function once() { d.removeEventListener('close', once); finish(null); });
      d.showModal();
    });
  }

  function newBook(fromSlug, fromTitle) {
    askNewBook(fromSlug ? 'Duplicate book' : 'New book', fromSlug ? fromTitle + ' (copy)' : '').then(function (res) {
      if (!res) return;
      var made = fromSlug ? duplicateFrom(fromSlug, res) : Promise.resolve(blankBook(res.title, lastArtist()));
      return made.then(function (b) {
        return put('kv', draftKey(res.slug), { book: b, removed: [], at: Date.now(), dirty: true });
      }).then(function () { location.href = '?book=' + encodeURIComponent(res.slug); });
    }).catch(function () { toast('Could not create that book.', 8000); });
  }

  function lastArtist() {
    var names = Object.keys(library.drafts).map(function (sl) { return library.drafts[sl].book.cover.eyebrow; })
      .concat((library.shelf.books || []).map(function (b) { return b.eyebrow; })).filter(Boolean);
    return names[0] || '';
  }

  // A copy keeps the layout and text. Images made in this browser are copied here; published
  // images are read from the original book until the first Save copies them into this one.
  function duplicateFrom(src, res) {
    var draft = library.drafts[src];
    var source = draft ? Promise.resolve(JSON.parse(JSON.stringify(draft.book)))
      : fetch(SITE + src + '/book.json', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (cfg) { return normalise(cfg, null); });
    return source.then(function (b) {
      var copies = [];
      Object.keys(b.images || {}).forEach(function (n) {
        var e = b.images[n];
        delete e.saved;
        if (e.local) {
          [e.src, e.small].forEach(function (path) {
            var f = fileOf(path);
            copies.push(get('files', fileKey(f, src)).then(function (blob) { if (blob) return put('files', fileKey(f, res.slug), blob); }));
          });
        } else if (!e.copyOf) {
          e.copyOf = { src: src + '/' + e.src, small: e.small ? src + '/' + e.small : '' };
        }
      });
      b.cover.title = res.title;
      b.title = [b.cover.eyebrow, res.title].filter(Boolean).join(', ');
      b.listed = true;
      delete b.updated;
      return Promise.all(copies).then(function () { return b; });
    });
  }

  function deleteBook(sl, title, online) {
    var warn = 'Delete "' + title + '"?' + (online ? '\n\nIt will be removed from your site and shelf, and its link will stop working.' : '') +
      (sl === LEGACY_SLUG ? '\n\nThe embed on your other website shows this book, so it will go blank there too.' : '') +
      (online ? '\n\n(It stays in your GitHub history, so it can be recovered.)' : '');
    if (!confirm(warn)) return;
    var removeLocal = function () { return Promise.all([delPrefix('files', sl + '/'), del('kv', draftKey(sl))]); };
    if (!online) {
      removeLocal().then(loadLibrary).then(renderLibrary).then(function () { toast('Deleted "' + title + '".'); });
      return;
    }
    withGh().then(function (gh) {
      if (!gh) return;
      toast('Deleting "' + title + '"…', 20000);
      ghCommit(gh, 'Delete "' + title + '" from the Spread editor', function (existing) {
        var entries = Object.keys(existing).filter(function (p) { return p.indexOf(sl + '/') === 0; })
          .map(function (p) { return { path: p, mode: '100644', type: 'blob', sha: null }; });
        return readShelf(gh).then(function (shelf) {
          shelf.books = (shelf.books || []).filter(function (b) { return b.slug !== sl; });
          entries.push({ path: 'books.json', mode: '100644', type: 'blob', content: JSON.stringify(shelf, null, 2) + '\n' });
          return entries;
        });
      }).then(removeLocal).then(function () {
        library.shelf.books = (library.shelf.books || []).filter(function (b) { return b.slug !== sl; });
        return loadLibrary().then(function () {
          library.shelf.books = (library.shelf.books || []).filter(function (b) { return b.slug !== sl; });
        });
      }).then(renderLibrary).then(function () {
        toast('Deleted "' + title + '". It disappears from the site within a minute.', 8000);
      }).catch(function (err) { toast(ghError(err, gh), 10000); });
    });
  }

  function showLibrary() {
    document.body.classList.add('is-library');
    document.title = 'My books · Spread';
    $('new-book').addEventListener('click', function () { newBook(); });
    return loadLibrary().then(renderLibrary);
  }

  function openBook() {
    $('book-name').textContent = SLUG;
    return loadDraft().then(function (had) { return had ? null : loadLive(); }).then(function () {
      $('book-name').textContent = (book.cover && book.cover.title) || SLUG;
      document.title = $('book-name').textContent + ' · Spread editor';
      render();
      measurePublished();
    }).catch(function (err) {
      console.error(err);
      toast('Could not open this book. Go back to My books and open it from there.', 10000);
    });
  }

  migrateLegacy().catch(function () {}).then(function () { return SLUG ? openBook() : showLibrary(); });
})();
