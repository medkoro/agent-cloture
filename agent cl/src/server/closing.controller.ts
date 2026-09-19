import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { join } from 'node:path';
import { z } from 'zod';
import { ClosingService } from '../platform/closing_service.js';

const RunSchema = z.object({
  dossier: z.string().min(1),
  period: z.string().regex(/^\d{4}-\d{2}$/),
  datasetDir: z.string().min(1).optional(),
});

const ApprovalSchema = z.object({ approver: z.literal('expert.comptable') });

@Controller('clotures')
export class ClosingController {
  constructor(@Inject(ClosingService) private readonly service: ClosingService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Post()
  async run(@Body() body: unknown) {
    const input = RunSchema.parse(body);
    return this.service.run({ ...input, datasetDir: input.datasetDir ?? join(process.cwd(), '..', 'datasets', input.dossier) });
  }

  @Post(':id/propositions/:propositionId/approve')
  approve(@Param('id') id: string, @Param('propositionId') propositionId: string, @Body() body: unknown) {
    const input = ApprovalSchema.parse(body);
    return this.service.approve(id, propositionId, input.approver);
  }
}
