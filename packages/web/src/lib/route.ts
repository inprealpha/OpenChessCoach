// How the hash router reads a link: #/menu, #/lesson/italian-game, #/review/12, #/board?fen=… ...
export type Route = { name: string; params: string[]; query: Record<string, string> };

export function parseRoute(hash: string): Route {
  const [path = '', search = ''] = hash.replace(/^#\/?/, '').split('?');
  // The pairing link (#pair=CODE) opens the app at its root once the code is used.
  if (path.startsWith('pair=')) return { name: '', params: [], query: {} };
  const [name = '', ...params] = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { name, params, query: Object.fromEntries(new URLSearchParams(search)) };
}
