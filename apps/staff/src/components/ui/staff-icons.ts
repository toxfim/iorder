// Navigation and shell icons of the staff design v8 (docs/private/design/v8/lu-icon.js, 24x24 stroke
// icons, currentColor). Kept as data rather than markup so StaffIcon renders them without v-html.
// Only the icons the staff app renders are kept.

interface Shape {
  readonly tag: 'path' | 'circle' | 'rect';
  readonly attrs: Readonly<Record<string, string>>;
}

const p = (d: string): Shape => ({ tag: 'path', attrs: { d } });
const circle = (cx: string, cy: string, r: string): Shape => ({
  tag: 'circle',
  attrs: { cx, cy, r },
});
const rect = (x: string, y: string, width: string, height: string, rx = '0'): Shape => ({
  tag: 'rect',
  attrs: { x, y, width, height, rx },
});

export const STAFF_ICONS = {
  copy: [
    rect('8', '8', '14', '14', '2'),
    p('M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'),
  ],
  user: [p('M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2'), circle('12', '7', '4')],
  dashboard: [
    rect('3', '3', '7', '9', '1'),
    rect('14', '3', '7', '5', '1'),
    rect('14', '12', '7', '9', '1'),
    rect('3', '16', '7', '5', '1'),
  ],
  bag: [
    p('M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z'),
    p('M3 6h18'),
    p('M16 10a4 4 0 0 1-8 0'),
  ],
  tags: [
    p('m15 5 6.3 6.3a2.4 2.4 0 0 1 0 3.4L17 19'),
    p(
      'M9.586 5.586A2 2 0 0 0 8.172 5H3a1 1 0 0 0-1 1v5.172a2 2 0 0 0 .586 1.414L8.29 18.29a2.426 2.426 0 0 0 3.42 0l3.58-3.58a2.426 2.426 0 0 0 0-3.42z',
    ),
  ],
  warehouse: [
    p(
      'M22 8.35V20a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8.35A2 2 0 0 1 3.26 6.5l8-3.2a2 2 0 0 1 1.48 0l8 3.2A2 2 0 0 1 22 8.35Z',
    ),
    p('M6 18h12'),
    p('M6 14h12'),
    rect('6', '10', '12', '12'),
  ],
  users: [
    p('M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2'),
    circle('9', '7', '4'),
    p('M22 21v-2a4 4 0 0 0-3-3.87'),
    p('M16 3.13a4 4 0 0 1 0 7.75'),
  ],
  building: [
    p('M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z'),
    p('M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2'),
    p('M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2'),
    p('M10 6h4'),
    p('M10 10h4'),
    p('M10 14h4'),
    p('M10 18h4'),
  ],
  calc: [
    rect('4', '2', '16', '20', '2'),
    p('M8 6h8'),
    p('M16 14v4'),
    p('M16 10h.01'),
    p('M12 10h.01'),
    p('M8 10h.01'),
    p('M12 14h.01'),
    p('M8 14h.01'),
    p('M12 18h.01'),
    p('M8 18h.01'),
  ],
  truck: [
    p('M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2'),
    p('M15 18H9'),
    p('M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14'),
    circle('17', '18', '2'),
    circle('7', '18', '2'),
  ],
  package: [
    p(
      'M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z',
    ),
    p('M12 22V12'),
    p('m3.3 7 8.7 5 8.7-5'),
    p('m7.5 4.27 9 5.15'),
  ],
  usercheck: [
    p('M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2'),
    circle('9', '7', '4'),
    p('m16 11 2 2 4-4'),
  ],
  down: [p('m6 9 6 6 6-6')],
  right: [p('m9 18 6-6-6-6')],
  // Top bar and user block.
  moon: [p('M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z')],
  sun: [
    circle('12', '12', '4'),
    p('M12 2v2'),
    p('M12 20v2'),
    p('m4.93 4.93 1.41 1.41'),
    p('m17.66 17.66 1.41 1.41'),
    p('M2 12h2'),
    p('M20 12h2'),
    p('m6.34 17.66-1.41 1.41'),
    p('m19.07 4.93-1.41 1.41'),
  ],
  bell: [p('M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9'), p('M10.3 21a1.94 1.94 0 0 0 3.4 0')],
  search: [circle('11', '11', '8'), p('m21 21-4.3-4.3')],
  logout: [p('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4'), p('m16 17 5-5-5-5'), p('M21 12H9')],
  x: [p('M18 6 6 18'), p('m6 6 12 12')],
  // Sidebar entries of the v8 pages that are still to come (history, bot settings, profile).
  history: [
    p('M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8'),
    p('M3 3v5h5'),
    p('M12 7v5l4 2'),
  ],
  bot: [
    p('M12 8V4H8'),
    rect('4', '8', '16', '12', '2'),
    p('M2 14h2'),
    p('M20 14h2'),
    p('M15 13v2'),
    p('M9 13v2'),
  ],
  usercircle: [p('M18 20a6 6 0 0 0-12 0'), circle('12', '10', '4'), circle('12', '12', '10')],
  // Dashboard KPI cards and the Xulosa card (v8 "Bosh sahifa").
  clock: [circle('12', '12', '10'), p('M12 6v6l4 2')],
  wallet: [
    p(
      'M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1',
    ),
    p('M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4'),
  ],
  alert: [circle('12', '12', '10'), p('M12 8v4'), p('M12 16h.01')],
  refresh: [
    p('M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8'),
    p('M21 3v5h-5'),
    p('M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16'),
    p('M8 16H3v5'),
  ],
  // Orders list and order page (v8 "Buyurtmalar", "Buyurtma sahifasi").
  filter: [p('M3 6h18'), p('M7 12h10'), p('M10 18h4')],
  check: [p('M20 6 9 17l-5-5')],
  circlecheck: [circle('12', '12', '10'), p('m9 12 2 2 4-4')],
  lock: [rect('3', '11', '18', '11', '2'), p('M7 11V7a5 5 0 0 1 10 0v4')],
  pencil: [
    p(
      'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z',
    ),
    p('m15 5 4 4'),
  ],
  minus: [p('M5 12h14')],
  plus: [p('M5 12h14'), p('M12 5v14')],
  message: [p('M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z')],
  trash: [
    p('M3 6h18'),
    p('M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6'),
    p('M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2'),
    p('M10 11v6'),
    p('M14 11v6'),
  ],
  phone: [rect('5', '2', '14', '20', '2'), p('M12 18h.01')],
  send: [
    p(
      'M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z',
    ),
    p('m21.854 2.147-10.94 10.939'),
  ],
  // Staff accounts (v8 "Xodimlar"): add button, administrator tile, row menu, login and password.
  userplus: [
    p('M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2'),
    circle('9', '7', '4'),
    p('M19 8v6'),
    p('M22 11h-6'),
  ],
  shield: [
    p(
      'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z',
    ),
  ],
  more: [circle('12', '12', '1'), circle('19', '12', '1'), circle('5', '12', '1')],
  key: [
    p(
      'M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z',
    ),
    circle('16.5', '7.5', '.5'),
  ],
  arrow: [p('M5 12h14'), p('m12 5 7 7-7 7')],
  // Leaves the staff app for another site (the customer site entry).
  external: [
    p('M15 3h6v6'),
    p('M10 14 21 3'),
    p('M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'),
  ],
  shieldcheck: [
    p(
      'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z',
    ),
    p('m9 12 2 2 4-4'),
  ],
  // The v8 Qoldiq source card (the sheet the stock is read from).
  archive: [
    rect('2', '3', '20', '5', '1'),
    p('M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8'),
    p('M10 12h4'),
  ],
  // The Narxlar "Excel yuklab olish" action (v8 lu-icon `download`).
  download: [p('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'), p('m7 10 5 5 5-5'), p('M12 15V3')],
  // The Narxlar "Excel yuklash" action (Lucide `upload`, the mirror of `download`; no v8 drawing).
  upload: [p('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'), p('m17 8-5-5-5 5'), p('M12 3v12')],
  // The "Excel orqali yuklash" menu item and the import file row (Lucide `sheet` and `file`).
  sheet: [
    rect('3', '3', '18', '18', '2'),
    p('M3 9h18'),
    p('M3 15h18'),
    p('M9 9v12'),
    p('M15 9v12'),
  ],
  file: [
    p('M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z'),
    p('M14 2v4a2 2 0 0 0 2 2h4'),
  ],
  // "Sheet tovari bilan birlashtirish": merging a staff-added product into a sheet product (Lucide `link`).
  link: [
    p('M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'),
    p('M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'),
  ],
  // The Brendlar entry: v8 has no brand icon, so Lucide's single `tag` (the family of `tags`).
  tag: [
    p(
      'M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z',
    ),
    circle('7.5', '7.5', '.5'),
  ],
  // Product photos (no v8 drawing): Lucide `image` for the placeholder and the upload action,
  // Lucide `star` for "make main".
  image: [
    rect('3', '3', '18', '18', '2'),
    circle('9', '9', '2'),
    p('m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21'),
  ],
  star: [
    p(
      'M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z',
    ),
  ],
} as const satisfies Record<string, readonly Shape[]>;

export type StaffIconName = keyof typeof STAFF_ICONS;
