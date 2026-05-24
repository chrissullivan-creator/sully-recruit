import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { DataCleanupContent } from '@/components/settings/DataCleanupContent';

export default function DataCleanup() {
  return (
    <MainLayout>
      <PageHeader
        title="Data Cleanup"
        description="Resolve auto-added people, duplicates, ambiguous enrichments, and missing channel coverage."
      />
      <div className="px-6 pb-6">
        <DataCleanupContent syncToUrl />
      </div>
    </MainLayout>
  );
}
