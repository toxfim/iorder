import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  PRICE_IMPORT_MAX_BYTES,
  priceImportConfirmRequestSchema,
  priceImportTemplateQuerySchema,
  type PriceImportConfirmRequest,
  type PriceImportConfirmResponse,
  type PriceImportPreviewResponse,
  type PriceImportTemplateQuery,
} from '@iorder/shared/staff-cost';
import type { Actor } from '../../../common/auth/actor.js';
import { CurrentActor, RequirePermission } from '../../../common/auth/route-access.js';
import { InputValidationError } from '../../../common/errors/domain-errors.js';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe.js';
import { IdentityService } from '../../identity/index.js';
import { PricingService, toPublishChangesWithRate } from '../../pricing/index.js';
import { PriceImportService } from './price-import.service.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** The part of a multer file this route reads (@types/multer is not a dependency). */
interface UploadedWorkbook {
  buffer: Buffer;
}

// One file, no text fields. multer's own limit is twice the contract's, so a file just over
// PRICE_IMPORT_MAX_BYTES gets the 422 FILE_TOO_LARGE the contract names (checked by the service),
// while anything far bigger is cut off by multer while it is being read (413). [P]
const UPLOAD_INTERCEPTOR = FileInterceptor('file', {
  limits: { fileSize: PRICE_IMPORT_MAX_BYTES * 2, files: 1, fields: 0, parts: 2 },
});

// HTTP only. The price list Excel import [C, 2026-11-09]: template, preview, confirm.
@Controller('staff/price-list/import')
@RequirePermission('UPDATE_PRICE_LIST')
export class PriceImportController {
  constructor(
    private readonly imports: PriceImportService,
    private readonly pricing: PricingService,
    private readonly identity: IdentityService,
  ) {}

  @Get('template')
  @Header('Cache-Control', 'no-store')
  async template(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(priceImportTemplateQuerySchema)) query: PriceImportTemplateQuery,
  ): Promise<StreamableFile> {
    const file = await this.imports.template(actor, query.kind);
    return new StreamableFile(file.data, {
      type: XLSX_MIME,
      disposition: `attachment; filename="${file.fileName}"`,
      length: file.data.byteLength,
    });
  }

  @Post('preview')
  @HttpCode(200)
  @UseInterceptors(UPLOAD_INTERCEPTOR)
  async preview(
    @CurrentActor() actor: Actor,
    @UploadedFile() file: UploadedWorkbook | undefined,
  ): Promise<PriceImportPreviewResponse> {
    if (!file || !Buffer.isBuffer(file.buffer)) {
      throw new InputValidationError([{ path: 'file', message: 'the file part is required' }]);
    }
    return this.imports.preview(actor, file.buffer);
  }

  @Post()
  @HttpCode(200)
  async confirm(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(priceImportConfirmRequestSchema)) body: PriceImportConfirmRequest,
  ): Promise<PriceImportConfirmResponse> {
    const result = await this.imports.confirm(actor, body);
    const [snapshots, names] = await Promise.all([
      this.pricing.getRateSnapshots(actor, [result.version.id]),
      this.identity.findDisplayNames(
        result.version.publishedBy === null ? [] : [result.version.publishedBy],
      ),
    ]);
    return {
      version: toPublishChangesWithRate(result.version, 0, snapshots, names),
      createdCount: result.createdCount,
      updatedCount: result.updatedCount,
      unchangedCount: result.unchangedCount,
    };
  }
}
