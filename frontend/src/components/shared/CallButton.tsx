import { useState } from 'react';
import { Phone, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { authHeaders } from '@/lib/api-auth';

/**
 * Click-to-call button backed by RingCentral RingOut.
 *
 * RingOut first rings the signed-in recruiter's own phone, then bridges to the
 * candidate once they answer — so the toast tells them to pick up their phone.
 *
 * Reusable across the app: pass the destination `phone` plus the linked
 * record id (candidate_id OR contact_id) so the backend can log the attempt
 * against the right timeline. Render nothing when there's no number.
 */
export function CallButton({
  phone,
  candidateId,
  contactId,
  size = 'sm',
  variant = 'outline',
  label = 'Call',
  className,
  iconOnly = false,
  title,
}: {
  phone: string | null | undefined;
  candidateId?: string | null;
  contactId?: string | null;
  size?: 'sm' | 'default' | 'icon';
  variant?: 'outline' | 'ghost' | 'gold' | 'default';
  /** Button text. Ignored when iconOnly. */
  label?: string;
  className?: string;
  /** Render just the phone icon (e.g. inline next to a number). */
  iconOnly?: boolean;
  title?: string;
}) {
  const [calling, setCalling] = useState(false);

  if (!phone || !phone.trim()) return null;

  const placeCall = async () => {
    if (calling) return;
    setCalling(true);
    const toastId = toast.loading('Ringing your phone — pick up to connect…');
    try {
      const res = await fetch('/api/call/ringout', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({
          to: phone,
          candidate_id: candidateId || undefined,
          contact_id: contactId || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `Call failed (${res.status})`);
      }
      toast.success('Ringing your phone — pick up to connect…', { id: toastId });
    } catch (e: any) {
      toast.error(e?.message || 'Call failed', { id: toastId });
    } finally {
      setCalling(false);
    }
  };

  if (iconOnly) {
    return (
      <button
        type="button"
        onClick={placeCall}
        disabled={calling}
        title={title || `Call ${phone}`}
        aria-label={title || `Call ${phone}`}
        className={
          className ||
          'p-2 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50'
        }
      >
        {calling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Phone className="h-4 w-4" />}
      </button>
    );
  }

  return (
    <Button
      variant={variant as any}
      size={size as any}
      onClick={placeCall}
      disabled={calling}
      className={className}
      title={title || `Call ${phone}`}
    >
      {calling ? (
        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
      ) : (
        <Phone className="h-3.5 w-3.5 mr-1" />
      )}
      {label}
    </Button>
  );
}
