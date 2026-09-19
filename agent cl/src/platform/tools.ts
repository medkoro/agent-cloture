import { z } from 'zod';

const ToolNameSchema = z.enum(['get_policy', 'get_trial_balance', 'get_ledger_entries', 'post_approved_entry']);
const PostInputSchema = z.object({ proposition_id: z.string().min(1), jeton: z.string().min(1).optional() });
const EmptyInputSchema = z.record(z.never());

export type ToolName = z.infer<typeof ToolNameSchema>;
type Handler = (input: unknown) => Promise<unknown>;

export class ToolRegistry {
  constructor(private readonly handlers: Partial<Record<ToolName, Handler>>) {}

  async call(name: string, input: unknown): Promise<unknown> {
    const tool = ToolNameSchema.parse(name);
    const handler = this.handlers[tool];
    if (!handler) throw new Error(`Outil non enregistré: ${tool}`);
    if (tool === 'post_approved_entry') {
      const parsed = PostInputSchema.parse(input);
      if (!parsed.jeton) throw new Error('Un jeton d’approbation signé est obligatoire');
      return handler(parsed);
    }
    EmptyInputSchema.parse(input);
    return handler(input);
  }
}
