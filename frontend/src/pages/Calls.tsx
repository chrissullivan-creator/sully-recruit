import { MainLayout } from '@/components/layout/MainLayout';
import { CallsPanel } from '@/components/calls/CallsPanel';

// Standalone /calls route — thin wrapper around the shared CallsPanel, which
// is also embedded inside the Communication Hub (see Inbox.tsx). Keeping a
// single source of truth means both surfaces share the exact same call-log
// list, search, Log Call dialog, and CallDetailModal.
const Calls = () => (
  <MainLayout>
    <CallsPanel />
  </MainLayout>
);

export default Calls;
