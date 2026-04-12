import { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
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
        <div className="min-h-screen">
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
