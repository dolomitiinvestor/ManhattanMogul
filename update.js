// Keeps open tabs and Home Screen apps on the latest version.
// The service worker already loads fresh files on every launch, but a tab (or an
// iPhone Home Screen app) that is left open keeps running the old code forever.
// This checks the server when the app comes back to the foreground, when the
// network returns, and every 5 minutes while visible. If the files changed, it
// reloads. Mid-game it only reloads on return to the app (the game resumes after
// a reload); otherwise it shows an "Update" button so play isn't interrupted.
(() => {
  if (!location.protocol.startsWith('http')) return;

  const FILES = ['index.html', 'style.css', 'cards.js', 'game.js', 'app.js', 'update.js', 'sw.js'];
  const EVERY_MS = 5 * 60 * 1000;
  let baseline = null;   // file contents as of page load
  let blind = false;     // the load-time check failed (offline), so the page may be a stale cached copy
  let checking = false;
  let pending = false;   // an update is ready, waiting for a safe moment

  const reg = 'serviceWorker' in navigator
    ? navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => null)
    : Promise.resolve(null);

  // Fetch every file straight from the server. Returns null if offline.
  async function snapshot() {
    try {
      const texts = await Promise.all(FILES.map(async (f) => {
        const res = await fetch(`${f}?__check`, { cache: 'no-cache' });
        if (!res.ok) throw new Error(res.status);
        return res.text();
      }));
      return texts.join('\u0000');
    } catch { return null; }
  }

  const inGame = () => {
    try { return !!sessionStorage.getItem('mm-session'); } catch { return false; }
  };

  function reload() {
    pending = false;
    location.reload();
  }

  function showButton() {
    if (document.getElementById('update-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'update-btn';
    btn.textContent = 'New version ready · Update';
    btn.addEventListener('click', reload);
    document.body.appendChild(btn);
  }

  async function check(resumed = false) {
    if (checking || document.hidden) return;
    checking = true;
    try {
      (await reg)?.update().catch(() => {});
      const now = await snapshot();
      if (!now) { if (baseline === null) blind = true; return; }
      if (baseline === null) {
        baseline = now;
        if (!blind) return;
        pending = true;      // can't tell what's running, so load the fresh copy
      } else if (now !== baseline) pending = true;
      if (!pending) return;
      if (resumed || !inGame()) reload();
      else showButton();
    } finally {
      checking = false;
    }
  }

  // Baseline right after load, so we compare against the version that is running.
  if (document.readyState === 'complete') check();
  else addEventListener('load', () => check(), { once: true });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(true); });
  addEventListener('pageshow', (e) => { if (e.persisted) check(true); });
  addEventListener('online', () => check());
  setInterval(() => check(), EVERY_MS);
})();
