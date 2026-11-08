// PROTOTYPE (#80): version 1 of the phone's panel sheet. Starts as a copy of today's (v0); its
// agent replaces it. Its CSS lives in src/sheet-v1.css, scoped under :root[data-sheet="v1"].
import { v0 } from './v0.ts';
import type { SheetDriver } from './types.ts';

export const v1: SheetDriver = { ...v0 };
