// Icons used by the UI kit. Path data is copied from the inline SVG markup of the v1 design files
// (docs/private/design/v1: Dashboard v5-Neutral-Sidebar and iOrder Prototype v2). Stroke icons, currentColor,
// no icon library (specs.md section 8, rule 14). Only icons the app actually renders are kept.
// Kept as data rather than markup so AppIcon can render it without v-html.

export interface IconShape {
  readonly tag: 'path' | 'circle' | 'rect';
  readonly attrs: Readonly<Record<string, string>>;
}

export interface IconDef {
  readonly viewBox: string;
  readonly shapes: readonly IconShape[];
}

export const ICONS = {
  // Dropdown arrow (Dashboard v5, 12x12 box).
  chevron: {
    viewBox: '0 0 12 12',
    shapes: [{ tag: 'path', attrs: { d: 'M3 4.5l3 3 3-3' } }],
  },
  // Selected option / success (Prototype, 24x24 box).
  check: {
    viewBox: '0 0 24 24',
    shapes: [{ tag: 'path', attrs: { d: 'M5 12l5 5L20 7' } }],
  },
  // Empty state (Prototype).
  inbox: {
    viewBox: '0 0 24 24',
    shapes: [
      { tag: 'rect', attrs: { x: '4', y: '5', width: '16', height: '14', rx: '2' } },
      { tag: 'path', attrs: { d: 'M4 13h5l1 2h4l1-2h5' } },
    ],
  },
  // Permission-denied state (Prototype).
  lock: {
    viewBox: '0 0 24 24',
    shapes: [
      { tag: 'rect', attrs: { x: '5', y: '11', width: '14', height: '9', rx: '2' } },
      { tag: 'path', attrs: { d: 'M8 11V8a4 4 0 018 0v3' } },
    ],
  },
  // Search field (Dashboard v5, prices filter bar).
  search: {
    viewBox: '0 0 24 24',
    shapes: [
      { tag: 'circle', attrs: { cx: '11', cy: '11', r: '7' } },
      { tag: 'path', attrs: { d: 'M20 20l-3.5-3.5' } },
    ],
  },
  // Edit pencil (Dashboard v5, "Tahrirlash" button).
  edit: {
    viewBox: '0 0 24 24',
    shapes: [{ tag: 'path', attrs: { d: 'M4 20h4L19 9l-4-4L4 16v4z' } }],
  },
  // Not in the v1 files (they have no phone layout for the sidebar): the mobile menu button.
  // Same 24x24 stroke geometry as the others.
  menu: {
    viewBox: '0 0 24 24',
    shapes: [
      { tag: 'path', attrs: { d: 'M4 12h16' } },
      { tag: 'path', attrs: { d: 'M4 6h16' } },
      { tag: 'path', attrs: { d: 'M4 18h16' } },
    ],
  },
  // Not in the v1 files: the theme switch (a circle with the right half filled in).
  theme: {
    viewBox: '0 0 24 24',
    shapes: [
      { tag: 'circle', attrs: { cx: '12', cy: '12', r: '8' } },
      { tag: 'path', attrs: { d: 'M12 4a8 8 0 0 1 0 16z', fill: 'currentColor' } },
    ],
  },
} as const satisfies Record<string, IconDef>;

export type IconName = keyof typeof ICONS;
