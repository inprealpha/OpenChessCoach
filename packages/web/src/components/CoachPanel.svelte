<script lang="ts">
  // The Coach panel on every board screen, docked at the foot of the panel: the latest answer right
  // above the Ask box, earlier messages folded behind "Earlier", Why Questions and follow-ups, and a
  // greyed-out state when the desktop or Claude can't be reached.
  import type { Snippet } from 'svelte';
  import { MAX_QUESTION_LENGTH } from '@chess-coach/shared/protocol';
  import { api } from '../lib/api.svelte.ts';
  import type { CoachThread, Entry } from '../lib/coach.svelte.ts';

  interface Props {
    thread: CoachThread;
    /** Called with the Player's Why Question. */
    onwhy?: (question: string) => void | Promise<void>;
    whyLabel?: string;
    placeholder?: string;
    actions?: Snippet;
    /** What the Coach is for, shown until it has said something, so the panel never looks broken. */
    empty?: string;
    /** Why the Ask box takes no question right now, said in the box: it stays in its place, closed. */
    closed?: string;
  }
  let { thread, onwhy, whyLabel = 'Ask the Coach why', placeholder = 'Why is this move good or bad?', actions, empty, closed }: Props = $props();

  let question = $state('');
  let log: HTMLDivElement | undefined = $state();
  let whyInput: HTMLInputElement | undefined = $state();
  const available = $derived(api.coachReady);
  /** The count shows only near the limit, so a short question isn't cluttered with it. */
  const charsLeft = $derived(MAX_QUESTION_LENGTH - question.length);
  const COUNT_FROM = 50;

  /** The latest exchange: from the Player's last question on, or the Coach's last message. */
  const latestFrom = $derived.by(() => {
    const entries = thread.entries;
    for (let i = entries.length - 1; i >= 0; i--) if (entries[i]?.from === 'player') return i;
    return Math.max(0, entries.length - 1);
  });
  const earlier = $derived(thread.entries.slice(0, latestFrom));
  const latest = $derived(thread.entries.slice(latestFrom));

  /** The long entry the log was last scrolled to the start of: left alone after that. */
  let atStart: Element | null = null;
  $effect(() => {
    void thread.entries.length;
    void thread.entries[thread.entries.length - 1]?.text;
    // The newest entry in view: its end, or its start when it is taller than the log, so a long
    // answer is read from its first line.
    // Once at its first line, a long answer stays where the Player scrolls it while it streams.
    const last = [...(log?.querySelectorAll(':scope > .entry') ?? [])].at(-1);
    if (!log || !last) return;
    if (last === atStart) return;
    if (last.getBoundingClientRect().height > log.clientHeight) {
      log.scrollTop = last.getBoundingClientRect().top - log.getBoundingClientRect().top + log.scrollTop;
      atStart = last;
    } else log.scrollTop = log.scrollHeight;
  });

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (!available || thread.busy || !onwhy || closed) return;
    const asked = question.trim();
    const calls = thread.calls;
    question = '';
    await onwhy(asked);
    // The button was disabled while the Coach answered, which drops the focus: the box takes it back.
    // Not on a touch screen, where a focused box opens the on-screen keyboard over the board.
    if (document.activeElement === document.body && !matchMedia('(pointer: coarse)').matches) whyInput?.focus();
    // Not answered (the desktop refused it, or the Coach couldn't be reached): give it back to edit.
    if (asked && thread.calls > calls && thread.failed && !question) question = asked;
  }
</script>

<section class="coach" class:unavailable={!available} aria-label="Coach">
  <header>
    <h2>Coach</h2>
    <span class="status" role="status">
      {#if !available}Coach unavailable{:else if thread.busy}Answering…{:else}Coach ready{/if}
    </span>
  </header>
  {#if !available}
    <p class="reason">{api.coach.reason ?? 'The Coach is unavailable.'}</p>
  {:else if empty && !thread.entries.length}
    <p class="empty">{empty}</p>
  {/if}
  {#snippet message(entry: Entry)}
      <p class="entry from-{entry.from}" class:error={entry.error} class:streaming={entry.streaming} aria-busy={entry.streaming}>
        {#if entry.from === 'player'}<span class="who">You:</span>{/if}
        {entry.text}{#if entry.streaming}<span class="cursor" aria-hidden="true">▍</span>{/if}
      </p>
      {#if entry.streaming && entry.status && !entry.text}<p class="note" role="status">{entry.status}</p>{/if}
      {#if entry.engineQuestions}
        <p class="note">Checked with the Engine: {entry.engineQuestions} {entry.engineQuestions === 1 ? 'question' : 'questions'}</p>
      {/if}
      {#if entry.note}<p class="note">Added to your Player Profile: “{entry.note}”</p>{/if}
  {/snippet}
  <div class="log" bind:this={log} aria-live="polite" aria-label="Coach conversation">
    {#if earlier.length}
      <details class="earlier">
        <summary>Earlier ({earlier.length})</summary>
        {#each earlier as entry (entry.id)}{@render message(entry)}{/each}
      </details>
    {/if}
    {#each latest as entry (entry.id)}{@render message(entry)}{/each}
  </div>
  {#if actions}<div class="actions">{@render actions()}</div>{/if}
  {#if onwhy}
    <form onsubmit={submit}>
      <label class="visually-hidden" for="why-input">Your Why Question</label>
      <input
        id="why-input"
        bind:this={whyInput}
        bind:value={question}
        placeholder={closed ?? placeholder}
        disabled={!available || Boolean(closed)}
        maxlength={MAX_QUESTION_LENGTH}
        autocomplete="off"
        aria-describedby="why-chars-left"
      />
      <!-- "Ask" on a phone, where the box and the button share one row; the name stays the same. -->
      <button type="submit" disabled={!available || thread.busy || Boolean(closed)} aria-label={whyLabel}
        ><span class="long" aria-hidden="true">{whyLabel}</span><span class="short" aria-hidden="true">Ask</span></button
      >
    </form>
    <p id="why-chars-left" class="chars-left" data-testid="why-chars-left" aria-live="polite" hidden={charsLeft > COUNT_FROM}>
      {charsLeft} {charsLeft === 1 ? 'character' : 'characters'} left
    </p>
  {/if}
</section>

<style>
  .coach {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 0.6rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .unavailable { opacity: 0.6; filter: grayscale(1); }
  header { display: flex; justify-content: space-between; align-items: baseline; }
  h2 { margin: 0; font-size: 1rem; }
  .status { font-size: 0.8rem; color: var(--muted); }
  .reason { margin: 0; font-size: 0.85rem; }
  .empty { margin: 0; font-size: 0.9rem; color: var(--muted); }
  .log { flex: 0 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 0.5rem; }
  .log:empty { display: none; }
  .earlier { display: flex; flex-direction: column; gap: 0.5rem; font-size: 0.9rem; }
  .earlier[open] { padding-bottom: 0.4rem; border-bottom: 1px solid var(--line); }
  .earlier summary { cursor: pointer; color: var(--muted); font-size: 0.8rem; }
  .earlier > :global(p) { margin-top: 0.4rem; }
  .short { display: none; }
  /* Docked at the foot of the screen on a phone: the log keeps to a few lines above the Ask box,
     and the box and its button share one row. */
  @media (max-width: 820px) {
    .coach { gap: 0.35rem; padding: 0.45rem 0.6rem; border-radius: 10px 10px 0 0; }
    /* Docked at the foot of a phone's screen: two lines of the answer, more while typing. */
    .log { max-height: 3rem; }
    .coach:focus-within .log { max-height: 9rem; }
    h2 { font-size: 0.85rem; }
    .status { font-size: 0.75rem; }
    form { flex-wrap: nowrap; }
    input { flex-basis: auto; }
    .long { display: none; }
    .short { display: inline; }
  }
  .entry { margin: 0; line-height: 1.45; }
  .entry.from-player { color: var(--muted); }
  .who { font-weight: 600; margin-right: 0.3rem; }
  .error { color: var(--danger); }
  .note { margin: 0; font-size: 0.8rem; color: var(--muted); font-style: italic; }
  .cursor { animation: blink 1s steps(2) infinite; }
  @keyframes blink { to { opacity: 0; } }
  .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  /* The button wraps under the box where both don't fit on one line, so the question has room. */
  form { display: flex; flex-wrap: wrap; gap: 0.4rem; }
  input { flex: 1 1 15rem; min-width: 0; }
  .chars-left { margin: 0; font-size: 0.8rem; color: var(--muted); }
</style>
