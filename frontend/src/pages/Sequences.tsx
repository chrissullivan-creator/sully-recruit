import { MainLayout } from "@/components/layout/MainLayout";
import { SequenceList } from "@/components/sequences/SequenceList";

export default function Sequences() {
  return (
    <MainLayout>
      <div className="container mx-auto py-6">
        <SequenceList />
      </div>
    </MainLayout>
  );
}
