import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { SendOutPipeline } from '@/components/pipeline/SendOutPipeline';
import { useSendOutBoard } from '@/hooks/useData';

// Placeholder Send Outs page — will be replaced with the user's full design.
// For now it lists every send_out via the existing SendOutPipeline component
// and the send_out_board view, so the sidebar route resolves and the data is visible.
export default function SendOuts() {
  const { data: sendOuts = [], isLoading } = useSendOutBoard();

  return (
    <MainLayout>
      <PageHeader
        title="Send Outs"
        description="Every active send-out across the team."
      />
      <div className="p-8">
        <SendOutPipeline
          title="All Send Outs"
          sendOuts={sendOuts as any[]}
          isLoading={isLoading}
        />
      </div>
    </MainLayout>
  );
}
