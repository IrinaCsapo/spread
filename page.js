/*
 * A book's page: share link, WhatsApp, native share, embed code, and the banner shown
 * after Save while GitHub Pages publishes. Every book folder's index.html loads this.
 */
(function () {
  'use strict';

  var root = document.getElementById('book');
  var folder = location.pathname.replace(/index\.html$/, '').replace(/([^/])$/, '$1/');
  var link = location.origin + folder;
  var slug = folder.split('/').filter(Boolean).pop() || '';
  var title = (document.querySelector('meta[property="og:title"]') || {}).content || document.title;

  document.getElementById('share-url').value = link;
  document.getElementById('whatsapp').href = 'https://wa.me/?text=' + encodeURIComponent(title + ' ' + link);
  document.getElementById('embed-code').textContent =
    '<link rel="stylesheet" href="' + location.origin + '/spread.css">\n' +
    '<div class="spread" data-book="' + link + 'book.json"></div>\n' +
    '<script src="' + location.origin + '/vendor/page-flip.browser.js"></script>\n' +
    '<script src="' + location.origin + '/spread.js"></script>';

  // Only the artist's browser (the one holding a Save token) sees the Edit link.
  try {
    if (localStorage.getItem('spread-github')) {
      var edit = document.getElementById('edit-link');
      edit.href = '../editor/?book=' + encodeURIComponent(slug);
      edit.hidden = false;
    }
  } catch (e) {}

  function copy(text, button) {
    var label = button.textContent;
    function ok() { button.textContent = 'Copied'; setTimeout(function () { button.textContent = label; }, 1800); }
    function fallback() {
      var t = document.createElement('textarea');
      t.value = text; document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); ok(); } catch (e) {}
      t.remove();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, fallback);
    else fallback();
  }
  document.getElementById('copy-link').addEventListener('click', function () { copy(link, this); });
  document.getElementById('copy-embed').addEventListener('click', function () {
    copy(document.getElementById('embed-code').textContent, this);
  });
  document.getElementById('share-url').addEventListener('focus', function () { this.select(); });
  if (navigator.share) {
    var ns = document.getElementById('native-share');
    ns.hidden = false;
    ns.addEventListener('click', function () { navigator.share({ title: title, url: link }).catch(function () {}); });
  }

  // After Save: wait for GitHub Pages to publish the new book.json, then show it.
  var savedAt = new URLSearchParams(location.search).get('saved');
  if (!savedAt) return;
  var banner = document.getElementById('saved');
  banner.hidden = false;
  banner.textContent = 'Saved. Putting it online, this usually takes about a minute…';
  history.replaceState(null, '', location.pathname);
  var started = Date.now();
  function poll() {
    fetch('book.json?v=' + Date.now(), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('not yet');
      return r.json();
    }).then(function (cfg) {
      if (cfg.updated && cfg.updated >= savedAt) {
        banner.textContent = 'Your book is live. Share the link below.';
        banner.classList.add('is-live');
        if (root.spread) root.spread.destroy();
        root.spread = Spread.mount(root, cfg, '');
        document.getElementById('share').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else later();
    }).catch(later);
  }
  function later() {
    if (Date.now() - started < 5 * 60 * 1000) setTimeout(poll, 5000);
    else banner.textContent = 'Saved, but it is taking longer than usual to go live. Refresh in a few minutes.';
  }
  poll();
})();
