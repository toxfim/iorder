import { productCodeKey } from '@iorder/shared';
import { normalizeSheetText } from './sheet-values.js';

/**
 * WHICH sheet rows we read [C, owner 2026-11-17, data-model §6.4]: by the «Товар_ID» column. A row
 * is read when its product code is in the list, WHATEVER its «Поставщик» (returns and inventory
 * rows of a listed product count too). Every other row is skipped, counted in the report by
 * supplier and never stored. This replaced the supplier filter (alpha trade import, Beta system tm
 * fbs, TV Gamma Import, Delta Import, Samsung Trading (North)).
 *
 * Codes are compared with productCodeKey (spacing and letter case ignored), like everywhere else.
 */
export abstract class SheetRowSelection {
  /** True when the row with this raw «Товар_ID» cell is read. */
  abstract isSelected(rawProductCode: unknown): boolean;
}

export class ProductCodeSelection extends SheetRowSelection {
  private readonly keys: ReadonlySet<string>;

  constructor(codes: readonly string[]) {
    super();
    this.keys = new Set(codes.map(productCodeKey));
  }

  isSelected(rawProductCode: unknown): boolean {
    const code = normalizeSheetText(rawProductCode);
    return code !== null && this.keys.has(productCodeKey(code));
  }
}

// The owner's file "owner-product-list.xlsx" (2026-11-17), one block per brand sheet, then the products the
// supplier filter read until that day that the file does not name (kept so their stock stays live;
// the owner chose to keep them). Removing a code later stops its sync: its stored lines are no
// longer refreshed, so take a product off only together with its stock.
// prettier-ignore
export const SELECTED_PRODUCT_CODES: readonly string[] = [
  // File sheet «Xiaomi Eco-System»
  '36315', '36317', '36318', '36320', '36322', '36327', '36359', '36383', '37754', '38054',
  '38056', '38057', '38062', '38063', '38070', '38465', '38691', '38774', '38780', '38787',
  '38788', '38791', '38794', '38795', '38796', '38797', '38801', '38802', '38804', '38805',
  '39238', '39239', '39326', '39327', '39328', '39341', '39342', '39381', '39387', '39394',
  '39613', '39831', '39832', '39833', '39866', '39892', '39893', '40428', '40429', '40430',
  '40431', '40432', '40433', '40434', '40435', '40436', '40437', '40438', '40439', '40455',
  '40456', '40457', '40458', '40459', '40460', '40461', '40462', '40463', '40464', '40465',
  '40467', '40468', '40469', '40470', '40471', '40472', '40473', '40474', '40475', '40476',
  '40477', '40478', '40479', '40480', '40481', '40485', '40486', '40487', '40489', '40490',
  '40491', '40492', '40494', '40497', '40718', '40722', '40723', '40724', '40725', '40726',
  '40795', '40796', '40797', '40798', '40799', '40800', '40801', '40802', '40803', '40804',
  '40805', '40806', '40807', '40909', '40910', '40911', '40912', '40913', '40914', '40919',
  '40920', '40921', '40922', '40923', '40924', '40925', '40926', '40927', '40928', '40929',
  '40930', '40931', '40932', '41167', '41168', '41169', '41170', '41208', '41209',
  // File sheet «Xiaomi TV»
  '38692', '38693', '38694', '39854', '41232', '41233', '41234', '41235', '41236', '41237',
  '41238', '41239', '41240',
  // File sheet «Huawei»
  '40639', '40630', '40637', '40619', '40632', '40631', '40645', '40623', '40629', '40626',
  '40644', '40617', '40622', '40625', '40618', '40611', '40628', '40627', '40643', '40641',
  '40633', '40614', '40642', '40636', '40640', '40635', '40621', '41216', '41217', '41218',
  '41219', '41220',
  // File sheet «Xiaomi.Samsung смартфоны»
  '40775', '40776', '40777', '40778', '40779', '40780', '40781', '40782', '40783', '40784',
  '40785', '40786', '40810', '40811', '40812', '40816', '40817', '40818', '40819', '40820',
  '40821', '40851', '40853', '40854', '40857', '40860', '40861', '40862', '40863', '40864',
  '40865', '40866', '40867', '40868', '40869', '40870', '40871', '40872', '40873', '40874',
  '40875', '40876', '40877', '40878', '40879', '40986', '40987', '40988', '40989', '40990',
  '40991', '41198', '41199', '41200', '41201',
  // Read until 2026-11-17 through the supplier «alpha trade import»
  '37161', '37162', '38361', '38798', '40719', '40720', '40721', '40916', '40917', '40918',
  '41205', '41206',
  // Read until 2026-11-17 through the supplier «Beta system tm fbs»
  '36302', '36310', '36311', '36375', '41011', '41012',
  // Read until 2026-11-17 through the supplier «Delta Import»
  '40613', '40615', '40616', '40624', '40634',
  // Read until 2026-11-17 through the supplier «Samsung Trading (North)». 31966 (a washing
  // machine, in neither owner file) was taken off on 2026-11-18 at the owner's request.
  '37938', '37939', '37940', '38350', '38356', '38357', '38359', '38360', '38824',
  '38825', '38826', '38827', '38828', '38829', '38833', '38834', '38836', '38838', '38842',
  '38843', '38844', '39115', '39196', '39197', '39198', '39363', '39398', '39446', '39486',
  '39487', '39489', '39490', '39594', '39657', '39658', '39659', '39660', '39661', '39667',
  '39668', '39669', '39694', '39695', '39697', '39702', '39703', '39704', '39877', '40113',
  '40114', '40115', '40116', '40117', '40118', '40120', '40121', '40266', '40267', '40347',
  '40350', '40351', '40355', '40359', '40363', '40364', '40366', '40367', '40370', '40379',
  '40380', '40408', '40410', '40411', '40412', '40413', '40414', '40452', '40712', '40713',
  '40714', '40715', '40716',
];
