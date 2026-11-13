import { stockInsightsInputSchema } from '@cirne/contracts';
import { analyzeStockInsights } from '@cirne/domain';

export function diagnoseStockInsights(input: unknown) {
  const parsed = stockInsightsInputSchema.safeParse(input);
  if (!parsed.success) return {
    status: 'error' as const, code: 'VALIDATION_FAILED',
    issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code, message: issue.message })),
  };
  return { status: 'ok' as const, analysis: analyzeStockInsights(parsed.data) };
}
