import { Module } from '@nestjs/common';
import { ReceiptScanJobsService } from './receipt-scan-jobs.service';
import { ReceiptScanStore } from './receipt-scan.store';
import { ReceiptsController } from './receipts.controller';
import { ReceiptsService } from './receipts.service';
import { AuthModule } from '../auth/auth.module';
import { BudgetModule } from '../budget/budget.module';
import { FilesModule } from '../files/files.module';
import { LlmParseModule } from '../llm-parse/llm-parse.module';
import { PermissionsModule } from '../permissions/permissions.module';

/** Receipt scanning — photograph a bill, get an expense. */
@Module({
  imports: [
    LlmParseModule,
    AuthModule,
    BudgetModule,
    FilesModule,
    PermissionsModule,
  ],
  controllers: [ReceiptsController],
  providers: [ReceiptsService, ReceiptScanStore, ReceiptScanJobsService],
})
export class ReceiptsModule {}
