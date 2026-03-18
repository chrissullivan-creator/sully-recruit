import { Link, useLocation, useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { NotificationBell } from './NotificationBell';
import logo from '@/assets/emerald_gold.png';
import {
  LogOut, Users, UserCheck, Megaphone, Inbox, Briefcase, Building2,
  Settings, LayoutDashboard, Phone, ListTodo, FileText, Send, ChevronRight,
} from 'lucide-react';

// ---- nav structure ----
const flatNavAbove = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Inbox', href: '/inbox', icon: Inbox },
  { name: 'Jobs', href: '/jobs', icon: Briefcase },
  { name: 'Candidates', href: '/candidates', icon: UserCheck },
  { name: 'Resume Search', href: '/resume-search', icon: FileText },
  { name: 'Contacts', href: '/contacts', icon: Users },
  { name: 'Companies', href: '/companies', icon: Building2 },
];

const navGroups = [
  {
    name: 'Outreach',
    icon: Send,
    prefix: '/outreach',
    children: [{ name: 'Sequences', href: '/outreach/sequences' }],
  },
  {
    name: 'Marketing',
    icon: Megaphone,
    prefix: '/marketing',
    children: [{ name: 'Sequences', href: '/marketing/sequences' }],
  },
];

const flatNavBelow = [
  { name: 'Tasks', href: '/tasks', icon: ListTodo },
  { name: 'Calls', href: '/calls', icon: Phone },
  { name: 'Settings', href: '/settings', icon: Settings },
];

export function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, signOut } = useAuth();

  const initials = user?.user_metadata?.display_name
    ? user.user_metadata.display_name.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2)
    : user?.email?.slice(0, 2).toUpperCase() ?? '??';

  const displayName = user?.user_metadata?.display_name || user?.email || 'User';

  const handleSignOut = async () => {
    await signOut();
    navigate('/auth');
  };

  const isActive = (href: string) =>
    href === '/' ? location.pathname === '/' : location.pathname.startsWith(href);

  return (
    <aside className="fixed inset-y-0 left-0 z-50 flex w-64 flex-col bg-sidebar border-r border-sidebar-border">
      {/* Logo */}
      <div className="flex h-16 items-center justify-between px-6 border-b border-sidebar-border">
        <div className="flex items-center gap-3">
          <img src={logo} alt="Sully Recruit" className="h-9 w-9 object-contain" />
          <div>
            <h1 className="text-base font-bold tracking-wide text-sidebar-foreground uppercase">Emerald Recruit</h1>
            <p className="text-[9px] tracking-widest text-gold uppercase -mt-0.5">Sully Recruit</p>
          </div>
        </div>
        <NotificationBell />
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-0.5 px-3 py-4 overflow-y-auto">
        {/* Top flat items */}
        {flatNavAbove.map((item) => (
          <NavLink key={item.href} href={item.href} icon={item.icon} active={isActive(item.href)}>
            {item.name}
          </NavLink>
        ))}

        {/* Grouped sections: Outreach, Marketing */}
        {navGroups.map((group) => {
          const groupActive = location.pathname.startsWith(group.prefix);
          return (
            <div key={group.name} className="pt-1">
              {/* Section header — not a link itself, just a label */}
              <div className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-semibold select-none',
                groupActive ? 'text-sidebar-primary' : 'text-sidebar-foreground/70'
              )}>
                <group.icon className="h-4 w-4 shrink-0" />
                <span>{group.name}</span>
                <ChevronRight className={cn('h-3 w-3 ml-auto transition-transform', groupActive && 'rotate-90')} />
              </div>
              {/* Sub-items */}
              <div className="ml-4 space-y-0.5 mt-0.5">
                {group.children.map((child) => {
                  const childActive = location.pathname.startsWith(child.href);
                  return (
                    <Link
                      key={child.href}
                      to={child.href}
                      className={cn(
                        'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-all duration-150 border-l-2',
                        childActive
                          ? 'border-sidebar-primary bg-sidebar-accent text-sidebar-primary'
                          : 'border-transparent text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                      )}
                    >
                      {child.name}
                      {childActive && <div className="ml-auto h-1.5 w-1.5 rounded-full bg-sidebar-primary" />}
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}

        {/* Bottom flat items */}
        <div className="pt-1">
          {flatNavBelow.map((item) => (
            <NavLink key={item.href} href={item.href} icon={item.icon} active={isActive(item.href)}>
              {item.name}
            </NavLink>
          ))}
        </div>
      </nav>

      {/* User section */}
      <div className="border-t border-sidebar-border p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-sm font-medium text-accent-foreground">
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-sidebar-foreground truncate">{displayName}</p>
            <p className="text-xs text-muted-foreground truncate">{user?.email}</p>
          </div>
          <button onClick={handleSignOut} className="text-muted-foreground hover:text-foreground transition-colors" title="Sign out">
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}

// ---- small helper ----
function NavLink({
  href, icon: Icon, active, children,
}: {
  href: string;
  icon: React.ElementType;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={href}
      className={cn(
        'group flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-all duration-150',
        active
          ? 'bg-sidebar-accent text-sidebar-primary'
          : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
      )}
    >
      <Icon className="h-4 w-4" />
      {children}
      {active && <div className="ml-auto h-1.5 w-1.5 rounded-full bg-sidebar-primary" />}
    </Link>
  );
}
