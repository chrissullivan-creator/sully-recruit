import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { NotificationBell } from './NotificationBell';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import logo from '@/assets/emerald-e-logo.png';
import {
  LogOut, Users2, Megaphone, Inbox, Briefcase,
  Building2, Settings, LayoutDashboard, Phone, ListTodo, FolderSearch, Copy,
  Send, Martini, Calendar, BarChart3, Menu, X,
} from 'lucide-react';

// Counts for the Inbox + To-Do's sidebar badges. One query each, cached for
// 30s — cheap pings that keep the badge fresh without thrashing the DB.
function useSidebarCounts(userId: string | undefined) {
  const inbox = useQuery({
    queryKey: ['sidebar_inbox_unread'],
    queryFn: async () => {
      const { count } = await supabase
        .from('inbox_threads')
        .select('id', { count: 'exact', head: true })
        .eq('is_read', false)
        .eq('is_archived', false);
      return count ?? 0;
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const tasks = useQuery({
    queryKey: ['sidebar_tasks_due', userId],
    enabled: !!userId,
    queryFn: async () => {
      const { count } = await supabase
        .from('tasks')
        .select('id', { count: 'exact', head: true })
        .neq('status', 'completed')
        .or(`assigned_to.eq.${userId},created_by.eq.${userId}`);
      return count ?? 0;
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  return { inboxUnread: inbox.data ?? 0, tasksOpen: tasks.data ?? 0 };
}

const navigation = [
  { name: 'Dashboard',  href: '/',          icon: LayoutDashboard },
  { name: 'Inbox',      href: '/inbox',      icon: Inbox           },
  { name: 'Ask Joe',    href: '/ask-joe',    icon: Martini         },
  { name: 'Jobs',       href: '/jobs',       icon: Briefcase       },
  { name: 'People',     href: '/people',     icon: Users2          },
  { name: 'Companies',  href: '/companies',  icon: Building2       },
  { name: 'Sequences',  href: '/sequences',  icon: Megaphone       },
  { name: 'Submissions', href: '/send-outs', icon: Send            },
  { name: 'Source',     href: '/source',     icon: FolderSearch    },
  { name: "To-Do's",    href: '/tasks',      icon: ListTodo        },
  { name: 'Calendar',   href: '/calendar',   icon: Calendar        },
  { name: 'Calls',      href: '/calls',      icon: Phone           },
  { name: 'Reports',    href: '/reports',    icon: BarChart3       },
  { name: 'Duplicates', href: '/duplicates', icon: Copy            },
  { name: 'Settings',   href: '/settings',   icon: Settings        },
];

export function Sidebar() {
  const location  = useLocation();
  const navigate  = useNavigate();
  const { user, signOut } = useAuth();
  const { inboxUnread, tasksOpen } = useSidebarCounts(user?.id);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close drawer when route changes (so tapping a nav item dismisses it).
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);
  const badgeFor = (href: string): number | null => {
    if (href === '/inbox') return inboxUnread > 0 ? inboxUnread : null;
    if (href === '/tasks') return tasksOpen > 0 ? tasksOpen : null;
    return null;
  };

  const initials = user?.user_metadata?.display_name
    ? user.user_metadata.display_name.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2)
    : user?.email?.slice(0, 2).toUpperCase() ?? '??';

  const handleSignOut = async () => {
    await signOut();
    navigate('/auth');
  };

  return (
    <>
    {/* Mobile menu button — visible only below md breakpoint. */}
    <button
      onClick={() => setMobileOpen(true)}
      className="lg:hidden fixed top-2 left-2 z-50 p-2 rounded-lg bg-sidebar border border-sidebar-border text-sidebar-foreground shadow-sm"
      aria-label="Open menu"
    >
      <Menu className="h-4 w-4" />
    </button>

    {/* Backdrop on mobile when open. */}
    {mobileOpen && (
      <div
        className="lg:hidden fixed inset-0 z-40 bg-black/40"
        onClick={() => setMobileOpen(false)}
        aria-hidden
      />
    )}

    <aside className={cn(
      'fixed inset-y-0 left-0 z-50 flex w-64 flex-col bg-sidebar border-r border-sidebar-border transition-transform duration-200',
      mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
    )}>

      {/* Mobile close button */}
      <button
        onClick={() => setMobileOpen(false)}
        className="lg:hidden absolute top-2 right-2 p-1.5 rounded-md text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent"
        aria-label="Close menu"
      >
        <X className="h-4 w-4" />
      </button>

      {/* ── Logo ── */}
      <div className="flex h-16 items-center justify-between px-5 border-b border-sidebar-border">
        <div className="flex items-center justify-center flex-1">
          <img
            src={logo}
            alt="Emerald"
            className="h-12 w-12 object-contain drop-shadow-[0_0_6px_hsl(43_68%_50%/0.35)]"
          />
        </div>
        <NotificationBell />
      </div>

      {/* ── Navigation ── */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5">
        {navigation.map((item) => {
          const isActive =
            item.href === '/'
              ? location.pathname === '/'
              : item.href === '/people'
                ? ['/people', '/candidates', '/contacts'].some(p =>
                    location.pathname === p || location.pathname.startsWith(p + '/'))
                : location.pathname === item.href || location.pathname.startsWith(item.href + '/');

          return (
            <Link
              key={item.name}
              to={item.href}
              className={cn(
                'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150',
                isActive
                  ? 'bg-sidebar-accent text-sidebar-primary'
                  : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
              )}
            >
              <item.icon
                className={cn(
                  'h-4 w-4 shrink-0 transition-colors',
                  isActive
                    ? 'text-sidebar-primary'
                    : 'text-sidebar-foreground/50 group-hover:text-sidebar-foreground/80',
                )}
              />
              <span className="truncate">{item.name}</span>
              {(() => {
                const n = badgeFor(item.href);
                if (n) {
                  return (
                    <span className={cn(
                      'ml-auto inline-flex items-center justify-center min-w-[20px] h-[18px] px-1.5 rounded-full text-[10px] font-semibold tabular-nums shrink-0',
                      isActive
                        ? 'bg-sidebar-primary text-sidebar-primary-foreground'
                        : 'bg-sidebar-primary/30 text-sidebar-primary',
                    )}>
                      {n > 99 ? '99+' : n}
                    </span>
                  );
                }
                if (isActive) {
                  return <div className="ml-auto h-1.5 w-1.5 rounded-full bg-sidebar-primary shrink-0" />;
                }
                return null;
              })()}
            </Link>
          );
        })}
      </nav>

      {/* ── User section ── */}
      <div className="border-t border-sidebar-border p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15 border border-accent/25 text-xs font-semibold text-sidebar-primary">
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-sidebar-foreground truncate leading-none">
              {user?.user_metadata?.display_name || 'User'}
            </p>
            <p className="text-[11px] text-sidebar-foreground/45 truncate mt-0.5">
              {user?.email}
            </p>
          </div>
          <NotificationBell />
          <button
            onClick={handleSignOut}
            className="text-sidebar-foreground/40 hover:text-sidebar-foreground/80 transition-colors shrink-0"
            title="Sign out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
    </>
  );
}
