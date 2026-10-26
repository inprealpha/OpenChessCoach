// The opening Lessons: four openings for White, three defences for Black. Theme and endgame
// Lessons are in data/lesson-topics.json (ADR 0008).
import type { Side } from '@chess-coach/shared/chess';

export interface CatalogueEntry {
  id: string;
  name: string;
  side: Side;
  eco: string;
  /** Main line in SAN, from Lichess's chess-openings line plus the most common continuation. */
  mainLine: string;
  /** Lichess puzzle OpeningTags families for this Lesson. */
  puzzleTags: string[];
}

export const CATALOGUE: CatalogueEntry[] = [
  {
    id: 'italian-game',
    name: 'Italian Game',
    side: 'white',
    eco: 'C54',
    mainLine: 'e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d4 exd4 cxd4 Bb4+ Bd2',
    puzzleTags: ['Italian_Game'],
  },
  {
    id: 'ruy-lopez',
    name: 'Ruy Lopez',
    side: 'white',
    eco: 'C88',
    mainLine: 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3',
    puzzleTags: ['Ruy_Lopez'],
  },
  {
    id: 'london-system',
    name: 'London System',
    side: 'white',
    eco: 'D00',
    mainLine: 'd4 d5 Bf4 Nf6 e3 e6 Nf3 c5 c3 Nc6 Nbd2 Bd6 Bg3',
    puzzleTags: ['London_System', 'Queens_Pawn_Game_London_System', 'Queens_Pawn_Game_Accelerated_London_System', 'Indian_Defense_London_System'],
  },
  {
    id: 'queens-gambit',
    name: "Queen's Gambit",
    side: 'white',
    eco: 'D20',
    mainLine: 'd4 d5 c4 dxc4 e3 Nf6 Bxc4 e6 Nf3 c5 O-O a6',
    puzzleTags: ['Queens_Gambit_Accepted'],
  },
  {
    id: 'caro-kann',
    name: 'Caro-Kann Defence',
    side: 'black',
    eco: 'B18',
    mainLine: 'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5 Ng3 Bg6 h4 h6 Nf3 Nd7',
    puzzleTags: ['Caro-Kann_Defense'],
  },
  {
    id: 'two-knights-defence',
    name: 'Two Knights Defence',
    side: 'black',
    eco: 'C58',
    mainLine: 'e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5 Na5 Bb5+ c6 dxc6 bxc6 Bd3 Nd5 Nf3 Bd6',
    puzzleTags: ['Italian_Game_Two_Knights_Defense'],
  },
  {
    id: 'queens-gambit-declined',
    name: "Queen's Gambit Declined",
    side: 'black',
    eco: 'D63',
    mainLine: 'd4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O Nf3 Nbd7',
    puzzleTags: ['Queens_Gambit_Declined'],
  },
];
