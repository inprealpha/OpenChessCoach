import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { api } from './lib/api.svelte.ts';

void api.init();
mount(App, { target: document.getElementById('app') as HTMLElement });

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}

// A tab left open across an update still runs the previous build, and the update took its Lesson
// and Puzzle chunks away: reload to fetch the new app. At most once a minute, so a chunk that
// stays out of reach can't reload the page in a loop. A chunk also fails when the desktop is out
// of reach, and without a service worker to serve the app a reload would then land on the
// browser's error page, so the desktop has to answer first.
window.addEventListener('vite:preloadError', () => {
  try {
    const last = Number(sessionStorage.getItem('reloadedForUpdate') ?? 0);
    if (Date.now() - last < 60_000) return;
  } catch {
    return;
  }
  const reachable = navigator.serviceWorker?.controller
    ? Promise.resolve(true)
    : fetch('/', { cache: 'no-store' }).then((r) => r.ok, () => false);
  void reachable.then((ok) => {
    if (!ok) return;
    try {
      sessionStorage.setItem('reloadedForUpdate', String(Date.now()));
    } catch {
      return;
    }
    location.reload();
  });
});
