import { Link, useLocation, useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { NotificationBell } from './NotificationBell';
import logo from '@/assets/emerald-logo.jpeg';
import {
  LogOut, Users, UserCheck, Megaphone, Inbox, Briefcase,
  Building2, Settings, LayoutDashboard, Phone, ListTodo,
  FileText, Linkedin,
} from 'lucide-react';

const navigation = [
  { name: 'Dashboard',       href: '/',               icon: LayoutDashboard },
  { name: 'Inbox',           href: '/inbox',           icon: Inbox           },
  { name: 'Jobs',            href: '/jobs',            icon: Briefcase       },
  { name: 'Candidates',      href: '/candidates',      icon: UserCheck       },
  { name: 'Resume Search',   href: '/resume-search',   icon: FileText        },
  { name: 'LinkedIn Search', href: '/linkedin-search', icon: Linkedin        },
  { name: 'Contacts',        href: '/contacts',        icon: Users           },
  { name: 'Companies',       href: '/companies',       icon: Building2       },
  { name: 'Sequences',       href: '/campaigns',       icon: Megaphone       },
  { name: 'Tasks',           href: '/tasks',           icon: ListTodo        },
  { name: 'Calls',           href: '/calls',           icon: Phone           },
  { name: 'Settings',        href: '/settings',        icon: Settings        },
];

export function Sidebar() {
  const location  = useLocation();
  const navigate  = useNavigate();
  const { user, signOut } = useAuth();

  const initials = user?.user_metadata?.display_name
    ? user.user_metadata.display_name.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2)
    : user?.email?.slice(0, 2).toUpperCase() ?? '??';

  const handleSignOut = async () => {
    await signOut();
    navigate('/auth');
  };

  return (
    <aside className="fixed inset-y-0 left-0 z-50 flex w-64 flex-col bg-sidebar border-r border-sidebar-border">

      {/* ── Logo ── */}
      <div className="flex h-16 items-center justify-between px-5 border-b border-sidebar-border">
        <img src={logo} alt="Sully Recruit" className="h-10 w-10 object-contain shrink-0" style={{ mixBlendMode: 'lighten' }} />
        <NotificationBell />
      </div>

      {/* ── Navigation ── */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5">
        {navigation.map((item) => {
          const isActive =
            item.href === '/'
              ? location.pathname === '/'
              : location.pathname === item.href || location.pathname.startsWith(item.href + '/');

          return (
            <Link
              key={item.name}
              to={item.href}
              className={cn(
                'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150',
                isActive
                  ? 'bg-sidebar-accent text-gold shadow-sm'
                  : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
              )}
            >
              <item.icon
                className={cn(
                  'h-4 w-4 shrink-0 transition-colors',
                  isActive ? 'text-gold' : 'text-sidebar-foreground/50 group-hover:text-sidebar-foreground/80',
                )}
              />
              <span className="truncate">{item.name}</span>
              {isActive && (
                <div className="ml-auto h-1.5 w-1.5 rounded-full bg-gold shrink-0" />
              )}
            </Link>
          );
        })}
      </nav>

      {/* ── User section ── */}
      <div className="border-t border-sidebar-border p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gold/15 border border-gold/25 text-xs font-semibold text-gold">
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
  );
}
