import { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { GlobalSearch } from './GlobalSearch';
import { AskJoeButton } from '@/components/AskJoeButton';
import { RouteErrorBoundary } from '@/components/RouteErrorBoundary';
import { JoeErrorBoundary } from '@/components/joe/JoeErrorBoundary';

interface MainLayoutProps {
  children: ReactNode;
}

export function MainLayout({ children }: MainLayoutProps) {
  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <main className="pl-64">
        {/* Sticky top bar — global search is always reachable from any page. */}
        <div className="sticky top-0 z-40 flex items-center gap-3 px-6 lg:px-8 h-12 border-b border-card-border bg-page-bg/95 backdrop-blur-sm">
          <GlobalSearch />
        </div>
        <div className="min-h-[calc(100vh-3rem)]">
          <RouteErrorBoundary>
            {children}
          </RouteErrorBoundary>
        </div>
      </main>
      <JoeErrorBoundary>
        <AskJoeButton />
      </JoeErrorBoundary>
    </div>
  );
}
