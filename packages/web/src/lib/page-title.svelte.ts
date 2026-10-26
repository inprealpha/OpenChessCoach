// The part of the page title a screen fills in once it knows what it shows, such as the game a
// Review is about. App.svelte puts it in place of the screen's name.
export const pageTitle = $state<{ text: string | null }>({ text: null });

/** Names the page after `text()` while the calling screen is shown. Call it as the screen is created. */
export function titleFrom(text: () => string | null | undefined): void {
  $effect(() => {
    const t = text();
    if (!t) return;
    pageTitle.text = t;
    return () => {
      // The next screen may already have set its own.
      if (pageTitle.text === t) pageTitle.text = null;
    };
  });
}
