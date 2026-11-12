// The script an HTML card puts in front of its page (cardRenderer.ts's
// `renderHtmlFrameInto`), and what the board accepts back from it.
//
// An HTML card's page runs in a sandbox without `allow-same-origin`: it cannot
// reach this window, and this window cannot reach into it. Everything the two
// say to each other goes through `postMessage`, and the bridge is the page's
// end of that — a fixed piece of source, handed the card's state as data, and
// run before anything the page itself contains.

/** Marks a message as the bridge's. The page can post anything; the board
 * listens only for this shape, and only from the card's own frame. */
const BRIDGE_MARK = 'yoloWhiteboardPage'

/**
 * How much a page may keep in its `localStorage`, counted the way browsers
 * count it: the UTF-16 length of every key plus its value.
 *
 * What a page stores is written into the board file, which is rewritten
 * whole on every save, so the limit is the board's rather than the page's.
 * 64K characters keeps a board with a few such cards in the low hundreds of
 * kilobytes, and is far more than a page needs to remember what its controls
 * were set to — the state this exists for. Past it, `setItem` throws
 * `QuotaExceededError`, as a browser's does when its own quota is full.
 */
export const PAGE_STORAGE_LIMIT = 64 * 1024

/** What a page keeps of itself: fileFormat.ts's `startScroll` (0 for the
 * top) and `storage`, as the bridge and the board pass them. */
export type PageMemory = Readonly<{
  scroll: number
  storage: Readonly<Record<string, string>>
}>

/** The size of a storage, as PAGE_STORAGE_LIMIT counts it. */
export function storageSize(storage: Readonly<Record<string, string>>): number {
  let size = 0
  for (const [key, value] of Object.entries(storage)) {
    size += key.length + value.length
  }
  return size
}

/**
 * The bridge's own source, run with the card's memory as its argument.
 *
 *   - `localStorage` is the page's own, sandboxed away (it throws
 *     `SecurityError` without `allow-same-origin`), so the bridge defines
 *     one on `window` that holds what the card remembered and reports each
 *     change — once per task, however many writes it made. A Proxy, so the
 *     page can use it as a real `Storage` is used: `getItem`/`setItem`, and
 *     also `localStorage.key = value` and `Object.keys(localStorage)`.
 *     `sessionStorage` is stood in for the same way, in memory only.
 *   - Scrolling is reported as the fraction of the page above its top edge,
 *     once per frame, and put back when the page has loaded — only from
 *     then on, so a page still laying itself out at the top does not
 *     overwrite where it was left.
 */
const BRIDGE_SOURCE = `(function (init) {
  'use strict';
  var parentWindow = window.parent;
  function post(message) {
    message.${BRIDGE_MARK} = 1;
    parentWindow.postMessage(message, '*');
  }

  function createStorage(entries, changed) {
    var data = Object.create(null);
    var size = 0;
    Object.keys(entries).forEach(function (key) {
      data[key] = entries[key];
      size += key.length + entries[key].length;
    });
    function snapshot() {
      var copy = {};
      Object.keys(data).forEach(function (key) { copy[key] = data[key]; });
      return copy;
    }
    var api = {
      key: function (index) {
        var keys = Object.keys(data);
        index = Math.floor(Number(index));
        return index >= 0 && index < keys.length ? keys[index] : null;
      },
      getItem: function (key) {
        key = String(key);
        return key in data ? data[key] : null;
      },
      setItem: function (key, value) {
        key = String(key);
        value = String(value);
        var had = key in data;
        if (had && data[key] === value) return;
        var next = size - (had ? key.length + data[key].length : 0) +
          key.length + value.length;
        if (next > init.limit) {
          throw new DOMException(
            "Setting the value of '" + key + "' exceeded the quota.",
            'QuotaExceededError'
          );
        }
        data[key] = value;
        size = next;
        changed(snapshot);
      },
      removeItem: function (key) {
        key = String(key);
        if (!(key in data)) return;
        size -= key.length + data[key].length;
        delete data[key];
        changed(snapshot);
      },
      clear: function () {
        if (Object.keys(data).length === 0) return;
        data = Object.create(null);
        size = 0;
        changed(snapshot);
      }
    };
    Object.defineProperty(api, 'length', {
      configurable: true,
      get: function () { return Object.keys(data).length; }
    });
    return new Proxy(api, {
      get: function (target, name) {
        if (typeof name === 'symbol' || name in target) return target[name];
        return name in data ? data[name] : undefined;
      },
      set: function (target, name, value) {
        if (typeof name !== 'symbol' && !(name in target)) {
          api.setItem(name, value);
        }
        return true;
      },
      has: function (target, name) {
        return name in target || name in data;
      },
      deleteProperty: function (target, name) {
        if (typeof name !== 'symbol') api.removeItem(name);
        return true;
      },
      ownKeys: function () {
        return Object.keys(data);
      },
      getOwnPropertyDescriptor: function (target, name) {
        if (typeof name !== 'string' || !(name in data)) return undefined;
        return {
          value: data[name],
          writable: true,
          enumerable: true,
          configurable: true
        };
      }
    });
  }

  function install(name, storage) {
    Object.defineProperty(window, name, {
      configurable: true,
      enumerable: true,
      get: function () { return storage; }
    });
  }

  var storageQueued = false;
  install('localStorage', createStorage(init.storage, function (snapshot) {
    if (storageQueued) return;
    storageQueued = true;
    setTimeout(function () {
      storageQueued = false;
      post({ storage: snapshot() });
    }, 0);
  }));
  install('sessionStorage', createStorage({}, function () {}));

  function scroller() {
    return document.scrollingElement || document.documentElement;
  }
  var restored = false;
  var scrollQueued = false;
  window.addEventListener('load', function () {
    restored = true;
    if (!(init.scroll > 0)) return;
    var root = scroller();
    window.scrollTo({ top: init.scroll * root.scrollHeight, behavior: 'instant' });
  });
  window.addEventListener('scroll', function () {
    if (!restored || scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(function () {
      scrollQueued = false;
      var root = scroller();
      post({
        scroll: root.scrollHeight > 0 ? root.scrollTop / root.scrollHeight : 0
      });
    });
  }, { passive: true });
})`

/**
 * `html` with the bridge in front of everything the page runs.
 *
 * Right after the doctype when there is one — in front of it would put the
 * document in quirks mode — and at the very start otherwise. A `<script>`
 * there is parsed into an implicit `<head>` ahead of the page's own, so it
 * runs before any script, stylesheet or markup of the page's; the page's own
 * `<html>` and `<head>` tags that follow are folded into the elements already
 * made, attributes and all, as the HTML parser does for any such document.
 */
export function withPageBridge(html: string, memory: PageMemory): string {
  const init = { ...memory, limit: PAGE_STORAGE_LIMIT }
  const script = `<script>${BRIDGE_SOURCE}(${scriptJson(init)});</script>`
  const doctype = DOCTYPE_PATTERN.exec(html)
  if (!doctype) return script + html
  const at = doctype.index + doctype[0].length
  return html.slice(0, at) + script + html.slice(at)
}

/** A doctype at the start of a document: after a byte-order mark, white
 * space and comments, which may come before it. */
const DOCTYPE_PATTERN = /^\uFEFF?(?:\s|<!--[\s\S]*?-->)*<!doctype\b[^>]*>/i

/**
 * JSON that can stand inside an inline `<script>`. The HTML parser ends a
 * script at the first `</script` whatever JavaScript thinks it is inside, and
 * `<!--` can change how it reads what follows, so every `<` is written as its
 * escape; U+2028 and U+2029 are escaped too, being line terminators to older
 * JavaScript parsers inside a string.
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/** What a message from a card's page reports of it. */
export type PageReport = Partial<PageMemory>

/**
 * What a message posted from a card's frame reports, or null when it is not
 * one of the bridge's. The page is untrusted — it can post anything, as
 * often as it likes, the bridge's mark included — so only the exact shape is
 * taken, and a storage past PAGE_STORAGE_LIMIT is refused here as well as in
 * the page: it is the board's file the limit protects.
 */
export function readPageMessage(data: unknown): PageReport | null {
  if (typeof data !== 'object' || data === null) return null
  const message = data as Record<string, unknown>
  if (message[BRIDGE_MARK] !== 1) return null
  const { scroll, storage } = message
  if (typeof scroll === 'number') {
    return Number.isFinite(scroll) && scroll >= 0 && scroll <= 1
      ? { scroll }
      : null
  }
  if (typeof storage !== 'object' || storage === null) return null
  if (Array.isArray(storage)) return null
  const entries = Object.entries(storage)
  if (entries.some(([, value]) => typeof value !== 'string')) return null
  const read = Object.fromEntries(entries) as Record<string, string>
  return storageSize(read) <= PAGE_STORAGE_LIMIT ? { storage: read } : null
}
