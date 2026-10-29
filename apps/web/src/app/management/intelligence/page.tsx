import { FieldIntelligencePage } from '@/features/management/field-intelligence-page';

export const dynamic = 'force-dynamic';

export default function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <FieldIntelligencePage searchParams={searchParams} />;
}
