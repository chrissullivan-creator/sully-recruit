import { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { SidebarProvider, useSidebar } from './SidebarContext';
import { GlobalSearch } from './GlobalSearch';
import { AskJoeLauncher } from '@/components/joe/AskJoeLauncher';
import { RouteErrorBoundary } from '@/components/RouteErrorBoundary';
import { JoeErrorBoundary } from '@/components/joe/JoeErrorBoundary';
import { cn } from '@/lib/utils';

interface MainLayoutProps {
  children: ReactNode;
}

function LayoutShell({ children }: MainLayoutProps) {
  const { collapsed } = useSidebar();
  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <main className={cn('transition-[padding] duration-200', collapsed ? 'lg:pl-16' : 'lg:pl-64')}>
        {/* Sticky top bar — global search is always reachable from any page.
            pl-12 on mobile leaves room for the hamburger button. */}
        <div className="sticky top-0 z-40 flex items-center gap-3 pl-12 lg:pl-8 pr-6 h-12 border-b border-card-border bg-page-bg/95 backdrop-blur-sm">
          <GlobalSearch />
          <div className="ml-auto">
            <JoeErrorBoundary>
              <AskJoeLauncher />
            </JoeErrorBoundary>
          </div>
        </div>
        <div className="min-h-[calc(100vh-3rem)]">
          <RouteErrorBoundary>
            {children}
          </RouteErrorBoundary>
        </div>
      </main>
    </div>
  );
}

export function MainLayout({ children }: MainLayoutProps) {
  return (
    <SidebarProvider>
      <LayoutShell>{children}</LayoutShell>
    </SidebarProvider>
  );
}
