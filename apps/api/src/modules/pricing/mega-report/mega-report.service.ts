import { Injectable } from '@nestjs/common';
import { commonProductName } from '@iorder/shared';
import type { Actor } from '../../../common/auth/actor.js';
import { can } from '../../../common/auth/can.js';
import { getBusinessTimeParts } from '../../../common/clock/business-time.js';
import { Clock } from '../../../common/clock/clock.js';
import { ForbiddenError } from '../../../common/errors/domain-errors.js';
import { CatalogService } from '../../catalog/index.js';
import { PriceReferenceRepository } from '../price-reference.repository.js';
import { buildMegaReportWorkbook, toReportProducts } from './mega-report-workbook.js';

export interface MegaReportFile {
  /** `Mega_report_YYYY-MM-DD_HH-mm.xlsx`, the moment in Asia/Tashkent. */
  fileName: string;
  data: Uint8Array;
}

/**
 * The "Mega report" of the Ostatok page (owner request, mega-report.md, 2026-11-10): every live
 * delivery line of the «Поставка» sheet as the sync stored it, one row per product with a band
 * of columns per delivery. STAFF-ONLY cost data (hard rule 7): the same permission as the cost
 * reference. Built from the database, never from the sheet, so a line the sync rejected is not
 * in it (the sync report lists those rows).
 */
@Injectable()
export class MegaReportService {
  constructor(
    private readonly references: PriceReferenceRepository,
    private readonly catalog: CatalogService,
    private readonly clock: Clock,
  ) {}

  async build(actor: Actor): Promise<MegaReportFile> {
    if (!can(actor, 'VIEW_COST_REFERENCE')) throw new ForbiddenError('Access denied');
    const now = this.clock.now();
    const lines = await this.references.findAllLiveForReport();
    const found = await this.catalog.findProductsByIds([...new Set(lines.map((l) => l.productId))]);
    const products = new Map(
      found.map((p) => [
        p.id,
        { productCode: p.productCode, name: commonProductName(p.translations, p.productCode) },
      ]),
    );
    return {
      fileName: `Mega_report_${fileStamp(now)}.xlsx`,
      data: await buildMegaReportWorkbook(toReportProducts(lines, products)),
    };
  }
}

function fileStamp(instant: Date): string {
  const t = getBusinessTimeParts(instant);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${t.year}-${two(t.month)}-${two(t.day)}_${two(t.hour)}-${two(t.minute)}`;
}
