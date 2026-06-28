import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useState, useEffect, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { NotificationBell } from './NotificationBell';
import { useSidebar } from './SidebarContext';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import logo from '@/assets/emerald-e-logo.png';
import { PersonAvatar } from '@/components/shared/PersonAvatar';
import { recruiterAvatar } from '@/lib/recruiterAvatars';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import type { LucideIcon } from 'lucide-react';
import {
  LogOut, Users2, Megaphone, Inbox, Briefcase,
  Building2, Settings, LayoutDashboard, FolderSearch,
  Send, Martini, Calendar, BarChart3, Menu, X,
  ChevronRight, PanelLeftClose, PanelLeft,
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
        .neq('task_type', 'meeting') // To-Do badge counts real tasks, not calendar meetings
        .or(`assigned_to.eq.${userId},created_by.eq.${userId}`);
      return count ?? 0;
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  return { inboxUnread: inbox.data ?? 0, tasksOpen: tasks.data ?? 0 };
}

type NavChild = { name: string; href: string };
type NavItem = { name: string; href: string; icon: LucideIcon; children?: NavChild[] };

// Sub-items deep-link to views that already exist as in-page tabs/toggles —
// the target pages read these query params (?view / ?tab / ?filter) to land
// on the right view. The "default" child carries no param so it lights up when
// the page loads with no param set.
const navigation: NavItem[] = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  {
    name: 'Communication Hub', href: '/inbox', icon: Inbox,
    children: [
      { name: 'All', href: '/inbox' },
      { name: 'Known', href: '/inbox?filter=known' },
      { name: 'Unknown', href: '/inbox?filter=unknown' },
    ],
  },
  { name: 'Ask Joe', href: '/ask-joe', icon: Martini },
  {
    name: 'Jobs', href: '/jobs', icon: Briefcase,
    children: [
      { name: 'Leads', href: '/jobs?view=leads' },
      { name: 'Hot Jobs', href: '/jobs' },
      { name: 'List', href: '/jobs?view=list' },
    ],
  },
  {
    name: 'People', href: '/people', icon: Users2,
    children: [
      { name: 'All People', href: '/people' },
      { name: 'Candidates', href: '/candidates' },
      { name: 'Clients', href: '/contacts' },
      { name: 'Applicants', href: '/people?tab=applicants' },
    ],
  },
  {
    name: 'Companies', href: '/companies', icon: Building2,
    children: [
      { name: 'All', href: '/companies' },
      { name: 'Clients', href: '/companies?filter=clients' },
      { name: 'Targets', href: '/companies?filter=targets' },
    ],
  },
  { name: 'Sequences', href: '/sequences', icon: Megaphone },
  {
    name: 'Send Outs', href: '/send-outs', icon: Send,
    children: [
      { name: 'Pipeline', href: '/send-outs' },
      { name: 'Analytics', href: '/send-outs?tab=analytics' },
      { name: 'All Send Outs', href: '/send-outs?tab=all' },
    ],
  },
  { name: 'Source', href: '/source', icon: FolderSearch },
  {
    name: 'Planner', href: '/calendar', icon: Calendar,
    children: [
      { name: 'Calendar', href: '/calendar' },
      { name: "To-Do's", href: '/tasks' },
      { name: 'Interviews', href: '/interviews' },
    ],
  },
  { name: 'Reports', href: '/reports', icon: BarChart3 },
  {
    name: 'Admin', href: '/settings', icon: Settings,
    children: [
      { name: 'Settings', href: '/settings' },
      { name: 'Custom Fields', href: '/settings?tab=custom-fields' },
      { name: 'Data Hygiene', href: '/settings?tab=hygiene' },
      { name: 'Audit Log', href: '/audit' },
    ],
  },
];

// All the route bases that count toward a nav item being "active" — includes
// its own href plus any child hrefs (so the parent lights up on any sub-view).
function pathBasesFor(item: NavItem): string[] {
  const bases = [item.href.split('?')[0]];
  item.children?.forEach((c) => bases.push(c.href.split('?')[0]));
  // Dashboard also owns /today; People also owns candidate/contact detail routes.
  if (item.href === '/') bases.push('/today');
  return Array.from(new Set(bases));
}

function pathMatches(pathname: string, base: string): boolean {
  if (base === '/') return pathname === '/';
  return pathname === base || pathname.startsWith(base + '/');
}

export function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { collapsed, toggle } = useSidebar();
  const { inboxUnread, tasksOpen } = useSidebarCounts(user?.id);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close drawer when route changes (so tapping a nav item dismisses it).
  useEffect(() => { setMobileOpen(false); }, [location.pathname, location.search]);

  const currentParams = useMemo(
    () => new URLSearchParams(location.search),
    [location.search],
  );

  const isItemActive = (item: NavItem): boolean =>
    pathBasesFor(item).some((b) => pathMatches(location.pathname, b));

  // A child is active when its base path matches AND its query params match the
  // URL. The "default" child (no params) is active only when none of the
  // sibling discriminator params are present.
  const childActive = (child: NavChild, siblings: NavChild[]): boolean => {
    const [base, query] = child.href.split('?');
    if (!pathMatches(location.pathname, base)) return false;
    const childParams = new URLSearchParams(query);
    if ([...childParams.keys()].length === 0) {
      const discriminators = new Set<string>();
      siblings.forEach((s) => {
        const q = s.href.split('?')[1];
        if (q) new URLSearchParams(q).forEach((_, k) => discriminators.add(k));
      });
      return ![...discriminators].some((k) => currentParams.has(k));
    }
    for (const [k, v] of childParams) {
      if (currentParams.get(k) !== v) return false;
    }
    return true;
  };

  // Track which parents are expanded; auto-expand the active parent on nav.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    const active = navigation.find((i) => i.children && isItemActive(i));
    if (active) setExpanded((prev) => new Set(prev).add(active.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, location.search]);

  const toggleExpand = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });

  const badgeFor = (href: string): number | null => {
    if (href === '/inbox') return inboxUnread > 0 ? inboxUnread : null;
    if (href === '/calendar') return tasksOpen > 0 ? tasksOpen : null;
    return null;
  };

  const handleSignOut = async () => {
    await signOut();
    navigate('/auth');
  };

  const Badge = ({ n, active }: { n: number; active: boolean }) => (
    <span className={cn(
      'ml-auto inline-flex items-center justify-center min-w-[20px] h-[18px] px-1.5 rounded-full text-[10px] font-semibold tabular-nums shrink-0',
      active ? 'bg-sidebar-primary text-sidebar-primary-foreground' : 'bg-sidebar-primary/15 text-sidebar-primary',
    )}>
      {n > 99 ? '99+' : n}
    </span>
  );

  // ── A single top-level row (expanded mode) ──
  const renderItem = (item: NavItem) => {
    const active = isItemActive(item);
    const hasChildren = !!item.children?.length;
    const isOpen = expanded.has(item.name);
    const badge = badgeFor(item.href);

    return (
      <div key={item.name}>
        <div
          className={cn(
            'group flex items-center gap-2 rounded-lg pl-3 pr-2 text-sm font-medium transition-all duration-150',
            active
              ? 'bg-sidebar-primary/10 text-sidebar-primary font-semibold'
              : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
          )}
        >
          <Link to={item.href} className="flex flex-1 items-center gap-3 py-2 min-w-0">
            <item.icon className={cn(
              'h-[18px] w-[18px] shrink-0 transition-colors',
              active ? 'text-sidebar-primary' : 'text-sidebar-foreground/50 group-hover:text-sidebar-foreground/80',
            )} />
            <span className="truncate">{item.name}</span>
          </Link>
          {badge != null && <Badge n={badge} active={active} />}
          {hasChildren ? (
            <button
              onClick={() => toggleExpand(item.name)}
              className="p-1 -mr-1 rounded-md text-sidebar-foreground/40 hover:text-sidebar-foreground/80 hover:bg-sidebar-accent transition-colors shrink-0"
              aria-label={isOpen ? `Collapse ${item.name}` : `Expand ${item.name}`}
            >
              <ChevronRight className={cn('h-3.5 w-3.5 transition-transform duration-200', isOpen && 'rotate-90')} />
            </button>
          ) : (
            active && badge == null && <div className="ml-auto h-1.5 w-1.5 rounded-full bg-sidebar-primary shrink-0" />
          )}
        </div>

        {/* Sub-items — animated reveal */}
        {hasChildren && (
          <div className={cn(
            'grid transition-all duration-200 ease-out',
            isOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
          )}>
            <div className="overflow-hidden">
              <div className="ml-[1.6rem] mt-0.5 mb-1 flex flex-col gap-0.5 border-l border-sidebar-border pl-2.5">
                {item.children!.map((child) => {
                  const cActive = childActive(child, item.children!);
                  return (
                    <Link
                      key={child.name}
                      to={child.href}
                      className={cn(
                        'rounded-md px-2.5 py-1.5 text-[13px] transition-colors',
                        cActive
                          ? 'bg-sidebar-primary/10 text-sidebar-primary font-semibold'
                          : 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground',
                      )}
                    >
                      {child.name}
                    </Link>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  // ── A single top-level row (collapsed rail mode) — icon + hover flyout ──
  const renderCollapsedItem = (item: NavItem) => {
    const active = isItemActive(item);
    const badge = badgeFor(item.href);

    return (
      <HoverCard key={item.name} openDelay={80} closeDelay={60}>
        <HoverCardTrigger asChild>
          <Link
            to={item.href}
            className={cn(
              'relative group flex items-center justify-center h-10 w-10 mx-auto rounded-lg transition-all duration-150',
              active
                ? 'bg-sidebar-primary/10 text-sidebar-primary'
                : 'text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground',
            )}
            aria-label={item.name}
          >
            <item.icon className="h-[18px] w-[18px]" />
            {badge != null && (
              <span className="absolute -top-0.5 -right-0.5 inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-sidebar-primary text-sidebar-primary-foreground text-[9px] font-semibold tabular-nums">
                {badge > 9 ? '9+' : badge}
              </span>
            )}
          </Link>
        </HoverCardTrigger>
        <HoverCardContent side="right" align="start" sideOffset={8} className="w-52 p-1.5">
          <Link
            to={item.href}
            className={cn(
              'block rounded-md px-2.5 py-1.5 text-sm font-semibold',
              active ? 'text-sidebar-primary' : 'text-foreground hover:bg-accent/40',
            )}
          >
            {item.name}
          </Link>
          {item.children?.length ? (
            <div className="mt-0.5 flex flex-col gap-0.5 border-t border-border pt-1">
              {item.children.map((child) => {
                const cActive = childActive(child, item.children!);
                return (
                  <Link
                    key={child.name}
                    to={child.href}
                    className={cn(
                      'rounded-md px-2.5 py-1.5 text-[13px] transition-colors',
                      cActive
                        ? 'text-sidebar-primary font-semibold bg-sidebar-primary/10'
                        : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
                    )}
                  >
                    {child.name}
                  </Link>
                );
              })}
            </div>
          ) : null}
        </HoverCardContent>
      </HoverCard>
    );
  };

  return (
    <>
      {/* Mobile menu button — visible only below lg breakpoint. */}
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
        'fixed inset-y-0 left-0 z-50 flex flex-col bg-sidebar border-r border-sidebar-border transition-[transform,width] duration-200',
        collapsed ? 'w-16' : 'w-64',
        mobileOpen ? 'translate-x-0 w-64' : '-translate-x-full lg:translate-x-0',
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
        <div className={cn(
          'flex h-20 items-center border-b border-sidebar-border',
          collapsed ? 'justify-center px-2' : 'justify-between px-5',
        )}>
          <div className={cn('flex items-center justify-center', !collapsed && 'flex-1')}>
            <div
              role="img"
              aria-label="Emerald Recruiting Group"
              className={cn('bg-primary', collapsed ? 'h-9 w-9' : 'h-16 w-16')}
              style={{
                WebkitMaskImage: `url(${logo})`,
                maskImage: `url(${logo})`,
                WebkitMaskSize: 'contain',
                maskSize: 'contain',
                WebkitMaskRepeat: 'no-repeat',
                maskRepeat: 'no-repeat',
                WebkitMaskPosition: 'center',
                maskPosition: 'center',
              }}
            />
          </div>
          {!collapsed && <NotificationBell />}
        </div>

        {/* ── Navigation ── */}
        <nav className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-4 space-y-0.5">
          {navigation.map((item) => (collapsed ? renderCollapsedItem(item) : renderItem(item)))}
        </nav>

        {/* ── Collapse toggle (desktop only) ── */}
        <button
          onClick={toggle}
          className={cn(
            'hidden lg:flex items-center gap-2 border-t border-sidebar-border px-3 py-2.5 text-[13px] font-medium text-sidebar-foreground/55 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors',
            collapsed && 'justify-center',
          )}
          title={collapsed ? 'Expand sidebar (⌘B)' : 'Collapse sidebar (⌘B)'}
        >
          {collapsed ? <PanelLeft className="h-4 w-4" /> : <><PanelLeftClose className="h-4 w-4" /><span>Collapse</span></>}
        </button>

        {/* ── User section ── */}
        <div className={cn('border-t border-sidebar-border', collapsed ? 'p-2' : 'p-4')}>
          {collapsed ? (
            <button onClick={handleSignOut} className="mx-auto flex" title={user?.email || 'Sign out'}>
              <PersonAvatar
                name={user?.user_metadata?.display_name || user?.email || 'User'}
                src={recruiterAvatar(user?.email)}
                size="sm"
              />
            </button>
          ) : (
            <div className="flex items-center gap-3">
              <PersonAvatar
                name={user?.user_metadata?.display_name || user?.email || 'User'}
                src={recruiterAvatar(user?.email)}
                size="md"
              />
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
          )}
        </div>
      </aside>
    </>
  );
}
