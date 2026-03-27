import { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { AskJoeButton } from '@/components/AskJoeButton';

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
      <AskJoeButton />
    </div>
  );
}
