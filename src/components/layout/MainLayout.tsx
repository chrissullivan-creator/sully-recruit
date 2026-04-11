import { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { AskJoeButton } from '@/components/AskJoeButton';
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
          {children}
        </div>
      </main>
      <JoeErrorBoundary>
        <AskJoeButton />
      </JoeErrorBoundary>
    </div>
  );
}
