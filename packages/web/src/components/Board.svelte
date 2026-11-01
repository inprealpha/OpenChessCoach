<script lang="ts">
  // The board: 64 buttons with stable accessible names ("e4, white knight"), click-to-move and
  // drag for touch and mouse, an overlay for arrows (the Coach's, a Review's) and highlights, the
  // last Move Grade's symbol on its own layer, and a legend of the arrows' colours under it.
  import type { Arrow } from '@chess-coach/shared/coach/types';
  import { untrack } from 'svelte';
  import { illegalReason, isCheck, isPromotion, legalDests, piecesOf, playUci, SIDE_NAMES, turnOf, type BoardPiece, type Side } from '@chess-coach/shared/chess';
  import { ARROW_LOOK, coachArrows, drawOrder, legendOf, type ArrowKind, type BoardArrow } from '../lib/arrows.ts';
  import type { GradeMark } from '../lib/grades.ts';
  import GradeSymbol from './GradeSymbol.svelte';

  interface Props {
    fen: string;
    orientation?: Side;
    /** Which side the Player may move. */
    movable?: Side | 'both' | 'none';
    lastMove?: { from: string; to: string } | undefined;
    /** The board's arrows; a Coach arrow on the board's last move is drawn as the move played. */
    arrows?: (BoardArrow | Arrow)[];
    highlights?: string[];
    /** A Move Grade to draw on the square its move landed on (nothing for Good). */
    gradeMark?: GradeMark | undefined;
    label?: string;
    onmove?: (uci: string) => void;
  }

  let {
    fen,
    orientation = 'white',
    movable = 'both',
    lastMove = undefined,
    arrows = [],
    highlights = [],
    gradeMark = undefined,
    label = 'Chess board',
    onmove,
  }: Props = $props();

  const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const ROLE_NAME: Record<string, string> = { pawn: 'pawn', knight: 'knight', bishop: 'bishop', rook: 'rook', queen: 'queen', king: 'king' };
  const ROLE_CHAR: Record<string, string> = { pawn: 'P', knight: 'N', bishop: 'B', rook: 'R', queen: 'Q', king: 'K' };

  let selected = $state<string | null>(null);
  let message = $state('');
  let promotion = $state<{ from: string; to: string } | null>(null);
  let drag = $state<{ from: string; piece: BoardPiece; x: number; y: number; moved: boolean } | null>(null);
  let boardEl: HTMLDivElement | undefined = $state();

  const pieces = $derived(new Map(piecesOf(fen).map((p) => [p.square, p])));
  const toMove = $derived(turnOf(fen));
  const canMove = $derived(movable === 'both' || movable === toMove);
  const dests = $derived(canMove ? legalDests(fen) : new Map<string, string[]>());
  const squares = $derived.by(() => {
    const ranks = orientation === 'white' ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
    const files = orientation === 'white' ? FILES : [...FILES].reverse();
    return ranks.flatMap((r) => files.map((f) => `${f}${r}`));
  });
  const checkSquare = $derived.by(() => {
    if (!isCheck(fen)) return null;
    for (const p of pieces.values()) if (p.role === 'king' && p.color === toMove) return p.square;
    return null;
  });

  // A new position drops what was said about the last one, such as "That move isn’t legal.".
  $effect(() => {
    void fen;
    selected = null;
    promotion = null;
    message = '';
  });

  // A board that stops taking moves (a finished game, the Engine thinking) drops a piece picked up
  // before, so the next click on it is not read as a move.
  $effect(() => {
    if (canMove) return;
    selected = null;
    promotion = null;
    message = '';
  });

  /** How long a piece takes to slide to its new square, as on Lichess. */
  const SLIDE_MS = 180;
  interface Drawing {
    fen: string;
    pieces: Map<string, BoardPiece>;
    lastMove: Props['lastMove'];
  }
  /** The position as last drawn, to tell which pieces moved. */
  let shown: Drawing | null = null;
  /** A move the Player just made by dragging: its piece is already on the square. */
  let dropped: { from: string; to: string } | null = null;

  // Pieces slide to their new squares when the position changes by one move: the board's last move
  // played, or the last move taken back. Each square's name and piece change at once, and the
  // piece's image starts where it was and glides home. Castling slides the king and the rook, a
  // promotion slides the pawn in as its new piece, and a captured piece just goes. Anything else
  // (the next Puzzle, a jump through the moves) shows at once, and so does everything when the
  // Player's device asks for less motion. A fresh Board slides nothing: the Board screen and the
  // Review draw one for a new board and for a key moment, which can be one move away but aren't moves.
  $effect(() => {
    const before = shown;
    shown = { fen, pieces, lastMove };
    if (before?.fen === fen) return;
    const skip = dropped;
    dropped = null;
    if (!before || !boardEl) return;
    // A square keeps its image when its piece changes, so a slide still running there would draw
    // the new piece gliding in from where the old one started: a quick step back over a capture.
    for (const sq of new Set([...before.pieces.keys(), ...pieces.keys()])) {
      const [was, now] = [before.pieces.get(sq), pieces.get(sq)];
      if (was?.color === now?.color && was?.role === now?.role) continue;
      for (const slide of boardEl.querySelector(`[data-square="${sq}"] img`)?.getAnimations() ?? []) slide.cancel();
    }
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!oneMoveApart(before, shown)) return;
    for (const [from, to] of slidesBetween(before.pieces, pieces)) {
      if (skip?.from === from && skip.to === to) continue;
      const a = untrack(() => center(from));
      const b = untrack(() => center(to));
      boardEl.querySelector(`[data-square="${to}"] img`)?.animate(
        [
          { transform: `translate(${(a.x - b.x) * 100}%, ${(a.y - b.y) * 100}%)`, zIndex: 1 },
          { transform: 'none', zIndex: 1 },
        ],
        { duration: SLIDE_MS, easing: 'ease' },
      );
    }
  });

  /** Whether one drawing follows the other by its last move: played forward, or taken back. */
  function oneMoveApart(a: Drawing, b: Drawing): boolean {
    const follows = (earlier: Drawing, later: Drawing): boolean => {
      const m = later.lastMove;
      if (!m) return false;
      const promoted = earlier.pieces.get(m.from)?.role === 'pawn' && /[18]$/.test(m.to);
      const role = later.pieces.get(m.to)?.role;
      const uci = `${m.from}${m.to}${promoted && role ? (ROLE_CHAR[role] ?? '').toLowerCase() : ''}`;
      return playUci(earlier.fen, uci)?.fenAfter.split(' ')[0] === later.fen.split(' ')[0];
    };
    return follows(a, b) || follows(b, a);
  }

  /** Which piece went where in one move: each newly placed piece comes from the square that lost the same piece, or for a promotion its pawn. */
  function slidesBetween(before: Map<string, BoardPiece>, after: Map<string, BoardPiece>): [string, string][] {
    const file = (p: BoardPiece): number => FILES.indexOf(p.square[0] as string);
    const rank = (p: BoardPiece): number => Number(p.square[1]);
    const same = (p: BoardPiece, q: BoardPiece | undefined): boolean => p.color === q?.color && p.role === q.role;
    const promotes = (pawn: BoardPiece, piece: BoardPiece): boolean => {
      const last = pawn.color === 'white' ? 8 : 1;
      return pawn.role === 'pawn' && piece.color === pawn.color && rank(piece) === last && Math.abs(rank(pawn) - last) === 1 && Math.abs(file(pawn) - file(piece)) <= 1;
    };
    const gone = [...before.values()].filter((p) => !same(p, after.get(p.square)));
    let came = [...after.values()].filter((p) => !same(p, before.get(p.square)));
    const slides: [string, string][] = [];
    for (const kin of [same, (p: BoardPiece, q: BoardPiece) => promotes(p, q) || promotes(q, p)]) {
      const unmatched: BoardPiece[] = [];
      for (const p of came) {
        const distance = (q: BoardPiece): number => Math.hypot(file(q) - file(p), rank(q) - rank(p));
        const from = gone.filter((q) => kin(p, q)).sort((q, r) => distance(q) - distance(r))[0];
        if (!from) unmatched.push(p);
        else {
          gone.splice(gone.indexOf(from), 1);
          slides.push([from.square, p.square]);
        }
      }
      came = unmatched;
    }
    return slides;
  }

  /** Moves the keyboard focus to the board, so the next Tab reaches its squares. */
  export function focus(): void {
    boardEl?.focus();
  }

  function squareName(sq: string): string {
    const p = pieces.get(sq);
    return p ? `${sq}, ${p.color} ${ROLE_NAME[p.role]}` : `${sq}, empty`;
  }

  function isLight(sq: string): boolean {
    const f = FILES.indexOf(sq[0] as string);
    const r = Number(sq[1]);
    return (f + r) % 2 === 1;
  }

  /**
   * The king's castling square when the Player moves the king onto its own rook, as Lichess allows:
   * g1 for the rook on h1, c1 for the one on a1. Undefined unless the king stands on e1 (e8 for
   * Black), where castling starts, and that castling is legal: from f1, g1 is a plain king move.
   */
  function castlingTo(from: string, to: string): string | undefined {
    const [king, rook] = [pieces.get(from), pieces.get(to)];
    if (king?.role !== 'king' || rook?.role !== 'rook' || rook.color !== king.color) return undefined;
    if (from !== (king.color === 'white' ? 'e1' : 'e8') || from[1] !== to[1]) return undefined;
    const square = `${to > from ? 'g' : 'c'}${from[1]}`;
    return (dests.get(from) ?? []).includes(square) ? square : undefined;
  }

  function attempt(from: string, to: string, dragged = false): void {
    if (from === to) return;
    to = castlingTo(from, to) ?? to;
    const targets = dests.get(from) ?? [];
    if (!targets.includes(to)) {
      // The reason, where it is about the Player's own king: the lesson a beginner needs.
      message = illegalReason(fen, from, to) ?? 'That move isn’t legal.';
      selected = null;
      return;
    }
    // A promoting pawn goes back to its square while the Player chooses, so it slides in even when dragged.
    if (isPromotion(fen, from, to)) {
      promotion = { from, to };
      return;
    }
    message = '';
    selected = null;
    if (dragged) dropped = { from, to };
    onmove?.(`${from}${to}`);
  }

  function promote(role: string): void {
    if (!promotion) return;
    const uci = `${promotion.from}${promotion.to}${role}`;
    promotion = null;
    selected = null;
    onmove?.(uci);
  }

  function click(sq: string): void {
    if (drag?.moved) return;
    const p = pieces.get(sq);
    if (selected) {
      // Another of the Player's pieces is picked up instead, unless it is the king's rook to castle with.
      if (p && p.color === toMove && canMove && sq !== selected && !castlingTo(selected, sq)) {
        selected = sq;
        return;
      }
      attempt(selected, sq);
      return;
    }
    if (!canMove) {
      if (p) message = movable === 'none' ? '' : 'It’s not your move.';
      return;
    }
    if (p && p.color === toMove) {
      selected = sq;
      message = '';
    } else if (p) {
      message = `It’s ${SIDE_NAMES[toMove]}’s move.`;
    }
  }

  function squareAt(x: number, y: number): string | null {
    if (!boardEl) return null;
    const rect = boardEl.getBoundingClientRect();
    const col = Math.floor(((x - rect.left) / rect.width) * 8);
    const row = Math.floor(((y - rect.top) / rect.height) * 8);
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    return squares[row * 8 + col] ?? null;
  }

  function pointerDown(e: PointerEvent, sq: string): void {
    const p = pieces.get(sq);
    if (!p || !canMove || p.color !== toMove || e.button !== 0) return;
    drag = { from: sq, piece: p, x: e.clientX, y: e.clientY, moved: false };
  }

  function pointerMove(e: PointerEvent): void {
    if (!drag) return;
    const moved = drag.moved || Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 6;
    drag = { ...drag, x: e.clientX, y: e.clientY, moved };
  }

  function pointerUp(e: PointerEvent): void {
    if (!drag) return;
    const d = drag;
    if (d.moved) {
      const target = squareAt(e.clientX, e.clientY);
      if (target) attempt(d.from, target, true);
      // Let the click that follows a drag be ignored.
      setTimeout(() => (drag = null), 0);
    } else drag = null;
  }

  function center(sq: string): { x: number; y: number } {
    const f = FILES.indexOf(sq[0] as string);
    const r = Number(sq[1]) - 1;
    return orientation === 'white' ? { x: f + 0.5, y: 7 - r + 0.5 } : { x: 7 - f + 0.5, y: r + 0.5 };
  }

  /** Each arrow by what it means, the move played drawn last so no other arrow hides it. */
  const drawn = $derived(
    drawOrder(arrows.map((a) => ('kind' in a ? a : (coachArrows([a], lastMove ? `${lastMove.from}${lastMove.to}` : undefined)[0] as BoardArrow)))),
  );
  /** The colours on the board now, for the legend under it. */
  const legend = $derived(legendOf(drawn));
  /** Arrowheads per kind; ids are per board, since two boards can be on one page. */
  const boardId = Math.random().toString(36).slice(2, 8);
  const headId = (kind: ArrowKind): string => `head-${boardId}-${kind}`;
</script>

<svelte:window onpointermove={pointerMove} onpointerup={pointerUp} />

<div class="wrap">
  <div class="board" role="group" aria-label={label} tabindex="-1" bind:this={boardEl} data-fen={fen} data-orientation={orientation}>
    {#each [0, 1, 2, 3, 4, 5, 6, 7] as row (row)}
      <div class="row">
        {#each squares.slice(row * 8, row * 8 + 8) as sq, col (sq)}
          {@const p = pieces.get(sq)}
          <button
            type="button"
            class="sq"
            class:light={isLight(sq)}
            class:dark={!isLight(sq)}
            class:selected={selected === sq}
            class:dest={selected !== null && (dests.get(selected) ?? []).includes(sq)}
            class:last={lastMove && (lastMove.from === sq || lastMove.to === sq)}
            class:check={checkSquare === sq}
            class:highlight={highlights.includes(sq)}
            aria-label={squareName(sq)}
            aria-pressed={selected === sq}
            data-square={sq}
            onclick={() => click(sq)}
            onpointerdown={(e) => pointerDown(e, sq)}
          >
            {#if p && !(drag?.moved && drag.from === sq)}
              <img src={`/pieces/${p.color === 'white' ? 'w' : 'b'}${ROLE_CHAR[p.role]}.svg`} alt="" draggable="false" />
            {/if}
            {#if col === 0}<span class="coord rank" aria-hidden="true">{sq[1]}</span>{/if}
            {#if row === 7}<span class="coord file" aria-hidden="true">{sq[0]}</span>{/if}
          </button>
        {/each}
      </div>
    {/each}

    <svg class="overlay" viewBox="0 0 8 8" aria-label="Coach annotations">
      <defs>
        {#each legend as kind (kind)}
          <marker id={headId(kind)} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="2.6" markerHeight="2.6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" style:fill={ARROW_LOOK[kind].color} />
          </marker>
        {/each}
      </defs>
      {#each highlights as sq (sq)}
        {@const c = center(sq)}
        <circle role="img" aria-label={`Highlight on ${sq}`} cx={c.x} cy={c.y} r="0.45" fill="none" stroke="#e68f00" stroke-width="0.07" opacity="0.9" />
      {/each}
      {#each drawn as a, i (`${a.from}${a.to}${i}`)}
        {@const s = center(a.from)}
        {@const t = center(a.to)}
        {@const len = Math.hypot(t.x - s.x, t.y - s.y)}
        <line
          role="img"
          aria-label={a.label}
          x1={s.x}
          y1={s.y}
          x2={t.x - ((t.x - s.x) / len) * 0.35}
          y2={t.y - ((t.y - s.y) / len) * 0.35}
          data-kind={a.kind}
          style:stroke={ARROW_LOOK[a.kind].color}
          stroke-width="0.16"
          stroke-linecap={ARROW_LOOK[a.kind].dashed ? 'butt' : 'round'}
          stroke-dasharray={ARROW_LOOK[a.kind].dashed ? '0.3 0.16' : undefined}
          opacity={a.kind === 'played' ? 0.85 : 0.8}
          marker-end={`url(#${headId(a.kind)})`}
        />
      {/each}
    </svg>

    {#if gradeMark}<GradeSymbol mark={gradeMark} {orientation} />{/if}

    {#if drag?.moved}
      <img
        class="ghost"
        src={`/pieces/${drag.piece.color === 'white' ? 'w' : 'b'}${ROLE_CHAR[drag.piece.role]}.svg`}
        alt=""
        style:left={`${drag.x}px`}
        style:top={`${drag.y}px`}
      />
    {/if}
  </div>

  {#if promotion}
    <div class="promotion" role="dialog" aria-label="Choose a piece to promote to">
      {#each [['q', 'queen'], ['r', 'rook'], ['b', 'bishop'], ['n', 'knight']] as [code, name] (code)}
        <button type="button" onclick={() => promote(code as string)} aria-label={`Promote to ${name}`}>
          <img src={`/pieces/${toMove === 'white' ? 'w' : 'b'}${ROLE_CHAR[name as string]}.svg`} alt="" />
        </button>
      {/each}
      <button type="button" class="cancel" onclick={() => (promotion = null)}>Cancel</button>
    </div>
  {/if}
  <div class="under">
    {#if legend.length}
      <ul class="legend" aria-label="Arrow colours">
        {#each legend as kind (kind)}
          <li data-kind={kind}><span class="swatch" class:dashed={ARROW_LOOK[kind].dashed} style:--swatch={ARROW_LOOK[kind].color} aria-hidden="true"></span>{ARROW_LOOK[kind].legend}</li>
        {/each}
      </ul>
    {/if}
    <p class="board-status" role="status" aria-live="polite">{message}</p>
  </div>
</div>

<style>
  .wrap {
    width: 100%;
    max-width: min(92vw, var(--board-max, 560px));
    margin: 0 auto;
    position: relative;
  }
  .board {
    position: relative;
    width: 100%;
    aspect-ratio: 1;
    display: grid;
    grid-template-rows: repeat(8, 1fr);
    border-radius: 4px;
    overflow: hidden;
    box-shadow: 0 2px 10px rgb(0 0 0 / 30%);
    touch-action: none;
    user-select: none;
  }
  /* Focused by a screen that moves on, such as a Lesson's next decision: a ring for the keyboard only. */
  .board:focus-visible { outline: 3px solid #1a73e8; outline-offset: 2px; }
  .board:focus:not(:focus-visible) { outline: none; }
  .row {
    display: grid;
    grid-template-columns: repeat(8, 1fr);
  }
  .sq {
    position: relative;
    border: 0;
    border-radius: 0;
    padding: 0;
    margin: 0;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .sq img {
    width: 100%;
    height: 100%;
    pointer-events: none;
  }
  .light { background: #f0d9b5; }
  .dark { background: #b58863; }
  .last.light { background: #cdd26a; }
  .last.dark { background: #aaa23a; }
  .selected { box-shadow: inset 0 0 0 4px rgb(20 85 30 / 70%); }
  .dest::after {
    content: '';
    position: absolute;
    width: 28%;
    height: 28%;
    border-radius: 50%;
    background: rgb(20 85 30 / 45%);
  }
  .check { background: radial-gradient(circle, #ff3030 0%, #e70000aa 30%, transparent 75%); }
  .highlight { box-shadow: inset 0 0 0 4px rgb(230 143 0 / 85%); }
  .sq:focus-visible { outline: 3px solid #1a73e8; outline-offset: -3px; }
  /* Coordinates at 11 px with at least 4.5:1 contrast on their square, above the piece. */
  .coord {
    position: absolute;
    z-index: 1;
    font-size: var(--coord-size, 11px);
    font-weight: 700;
    line-height: 1;
    pointer-events: none;
  }
  .light .coord { color: #7a5230; }
  .dark .coord { color: #2f1f10; }
  .coord.rank { top: 2px; left: 3px; }
  .coord.file { bottom: 2px; right: 3px; }
  .overlay {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }
  .ghost {
    position: fixed;
    width: min(11vw, 70px);
    height: min(11vw, 70px);
    transform: translate(-50%, -50%);
    pointer-events: none;
    z-index: 20;
  }
  .promotion {
    position: absolute;
    inset: 30% 10% auto;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    justify-content: center;
    background: var(--panel, #fff);
    padding: 0.75rem;
    border-radius: 8px;
    box-shadow: 0 4px 20px rgb(0 0 0 / 40%);
    z-index: 10;
  }
  .promotion button {
    flex: none;
    width: 56px;
    height: 56px;
    padding: 0;
    border-radius: 6px;
    border: 1px solid #ccc;
    background: #f7f7f7;
    color: #222;
  }
  .promotion .cancel { width: auto; padding: 0 0.75rem; }
  .promotion img { width: 100%; height: 100%; }
  /* One line under the board: the legend of the arrows on it, and why a move was refused. */
  .under {
    min-height: 1.4em;
    margin: 0.3rem 0 0;
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    align-items: baseline;
    gap: 0.1rem 1rem;
  }
  .board-status {
    margin: 0;
    font-size: 0.9rem;
    color: var(--muted, #555);
    text-align: center;
  }
  .legend { list-style: none; display: flex; flex-wrap: wrap; gap: 0.1rem 0.75rem; margin: 0; padding: 0; font-size: 0.8rem; color: var(--muted, #555); }
  .legend li { display: inline-flex; align-items: center; gap: 0.3rem; }
  @media (max-width: 820px) { .legend { gap: 0 0.5rem; font-size: 0.72rem; } }
  .swatch { display: inline-block; width: 1.1rem; height: 0.22rem; border-radius: 2px; background: var(--swatch); }
  .swatch.dashed { background: repeating-linear-gradient(90deg, var(--swatch) 0 0.3rem, transparent 0.3rem 0.45rem); }
</style>
