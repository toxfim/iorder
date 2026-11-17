/* global window, document */
/*
 * Applies the stored theme choice before the first paint (no flash). Classic script on
 * purpose: it is blocking, same-origin (no inline script, so a strict CSP needs no hash) and
 * must never throw. The key (theme.ts) and the two colours (--page in tokens.css) are duplicated here
 * on purpose; theme-init.test.ts keeps them in sync.
 */
(function () {
  try {
    var choice = null;
    try {
      choice = window.localStorage.getItem('iorder.theme');
    } catch {
      choice = null;
    }
    if (choice !== 'light' && choice !== 'dark') return;
    var root = document.documentElement;
    root.setAttribute('data-theme', choice);
    var colour = choice === 'dark' ? '#10141a' : '#ffffff';
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i += 1) metas[i].setAttribute('content', colour);
  } catch {
    // The page simply follows the system scheme.
  }
})();
