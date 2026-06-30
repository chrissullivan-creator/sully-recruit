import { ReactNode } from 'react';
import { Mail, Phone, Smartphone, Linkedin, MessageSquare, Contact as ContactIcon } from 'lucide-react';
import { SectionCard } from '@/components/shared/SectionCard';

interface Method {
  icon: ReactNode;
  label: string;
  value: string;
  href: string;
  external?: boolean;
}

/**
 * "Contact" panel — every way to reach a person (email, phone, mobile, text,
 * LinkedIn), each a clickable mailto/tel/sms/url. Shown on candidate + contact
 * detail pages in place of the old read-only "reached out" / details block.
 */
export function ContactPanel({ person, actions }: { person: any; actions?: ReactNode }) {
  const email = person?.work_email || person?.personal_email || person?.primary_email || person?.email;
  const phone = person?.phone;
  const mobile = person?.mobile_phone;
  const linkedin = person?.linkedin_url;

  const methods: Method[] = [
    email && { icon: <Mail className="h-4 w-4" />, label: 'Email', value: email, href: `mailto:${email}` },
    phone && { icon: <Phone className="h-4 w-4" />, label: 'Phone', value: phone, href: `tel:${phone}` },
    mobile && { icon: <Smartphone className="h-4 w-4" />, label: 'Mobile', value: mobile, href: `tel:${mobile}` },
    mobile && { icon: <MessageSquare className="h-4 w-4" />, label: 'Text', value: mobile, href: `sms:${mobile}` },
    linkedin && { icon: <Linkedin className="h-4 w-4" />, label: 'LinkedIn', value: 'View profile', href: linkedin, external: true },
  ].filter(Boolean) as Method[];

  return (
    <SectionCard title="Contact" icon={<ContactIcon className="h-4 w-4" />} actions={actions}>
      {methods.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">No contact info on file</p>
      ) : (
        <div className="space-y-1">
          {methods.map((m, i) => (
            <a
              key={i}
              href={m.href}
              target={m.external ? '_blank' : undefined}
              rel={m.external ? 'noreferrer' : undefined}
              className="flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/50"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted/60 text-muted-foreground">
                {m.icon}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{m.label}</span>
                <span className="truncate text-sm font-medium text-foreground">{m.value}</span>
              </span>
            </a>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
