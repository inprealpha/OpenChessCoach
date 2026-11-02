<script lang="ts">
  // The trial layouts that keep the Ask box out of sight until it is wanted (lib/layout.svelte.ts):
  // a button in the board's bar that pulls the panel up and puts the cursor in the Ask box.
  import { tick } from 'svelte';
  import { layout } from '../lib/layout.svelte.ts';
  import { sheet } from '../lib/sheet.svelte.ts';

  async function ask(): Promise<void> {
    sheet.pullUp();
    await tick();
    const input = document.getElementById('why-input');
    if (input instanceof HTMLInputElement) {
      input.scrollIntoView({ block: 'nearest' });
      input.focus();
    }
  }
</script>

{#if layout.askOnDemand}
  <button type="button" class="secondary ask-open" onclick={ask} aria-label="Ask the Coach" title="Ask the Coach a question">
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4z" /></svg>
    <span class="words">Ask</span>
  </button>
{/if}

<style>
  .ask-open { display: inline-flex; align-items: center; gap: 0.3rem; }
</style>
