// PROTOTYPE (#80): the version of the phone's panel sheet this page load uses (lib/sheet-variant.ts).
import { sheetVariant } from '../sheet-variant.ts';
import type { SheetDriver } from './types.ts';
import { v0 } from './v0.ts';
import { v1 } from './v1.ts';
import { v2 } from './v2.ts';
import { v3 } from './v3.ts';

export const driver: SheetDriver = { v0, v1, v2, v3 }[sheetVariant];
