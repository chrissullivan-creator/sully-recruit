import { useState, useEffect, useCallback } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { MessageTemplateManager } from '@/components/templates/MessageTemplateManager';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { authHeaders } from '@/lib/api-auth';
import { useJobFunctions } from '@/hooks/useData';
import { useQueryClient } from '@tanstack/react-query';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import {
  Settings as SettingsIcon,
  Link2,
  Mail,
  Linkedin,
  Key,
  Check,
  Loader2,
  PenLine,
  Eye,
  EyeOff,
  PhoneCall,
  ShieldCheck,
  AlertTriangle,
  Info,
  Play,
  Wrench,
  Briefcase,
  Target,
  Plus,
  Pencil,
  Trash2,
  X,
  CalendarClock,
  Copy,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Slider } from '@/components/ui/slider';

// ---- types ----
interface IntegrationConfig {
  [key: string]: string;
}

interface IntegrationRow {
  integration_type: string;
  config: IntegrationConfig;
  is_active: boolean;
}

interface LinkedinSeat {
  account_label: string | null;
  account_type: string;
  email_address: string | null;
  id: string;
  is_active: boolean;
  linkedin_capabilities: string[] | null;
  linkedin_capability: string | null;
  metadata: Record<string, any> | null;
  owner_user_id: string | null;
  unipile_account_id: string | null;
  updated_at: string;
}

// ---- component ----
const Settings = () => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('integrations');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  // Email SMTP state
  const [emailConfig, setEmailConfig] = useState<IntegrationConfig>({
    smtp_host: '',
    smtp_port: '587',
    smtp_user: '',
    smtp_pass: '',
    from_name: '',
    from_email: '',
  });
  const [emailActive, setEmailActive] = useState(false);

  // Unipile state
  const [unipileConfig, setUnipileConfig] = useState<IntegrationConfig>({
    api_key: '',
    base_url: '',
    account_id: '',
  });
  const [unipileActive, setUnipileActive] = useState(false);

  // RingCentral state
  const [backfillingRc, setBackfillingRc] = useState(false);
  const [backfillRcLookback, setBackfillRcLookback] = useState<string>('180');
  const [reextractingCalls, setReextractingCalls] = useState(false);
  const [backfillingRecentPeople, setBackfillingRecentPeople] = useState(false);
  const [recentPeopleLimit, setRecentPeopleLimit] = useState<string>('200');
  const [ringcentralConfig, setRingcentralConfig] = useState<IntegrationConfig>({
    client_id: '',
    client_secret: '',
    jwt_token: '',
    server_url: 'https://platform.ringcentral.com',
    phone_number: '',
  });
  const [ringcentralActive, setRingcentralActive] = useState(false);

  // Outlook state
  const [outlookConfig, setOutlookConfig] = useState<IntegrationConfig>({});
  const [outlookActive, setOutlookActive] = useState(false);

  // Clay enrichment state
  const [clayConfig, setClayConfig] = useState<IntegrationConfig>({
    api_key: '',
    webhook_url_candidates: '',
    webhook_url_contacts: '',
    table_id_candidates: '',
    table_id_contacts: '',
    webhook_secret: '',
  });
  const [clayActive, setClayActive] = useState(false);

  // Email signature
  const [signatureConfig, setSignatureConfig] = useState<IntegrationConfig>({
    signature_html: '',
    signature_text: '',
    signature_mode: 'text', // 'text' or 'html'
  });

  // LinkedIn safety limits
  const [linkedinLimits, setLinkedinLimits] = useState<IntegrationConfig>({
    daily_connections: '25',
    weekly_connections: '100',
    daily_messages: '50',
    daily_inmails: '25',
    daily_total_actions: '100',
    min_delay_between_actions: '45',
    warmup_enabled: 'true',
    warmup_days_completed: '0',
  });

  // Email sending limits
  const [emailLimits, setEmailLimits] = useState<IntegrationConfig>({
    daily_email_cap: '100',
    min_gap_minutes: '8',
    send_window_start: '8',
    send_window_end: '17',
  });

  // Job Functions state
  const { data: jobFunctions = [], isLoading: jobFunctionsLoading } = useJobFunctions();
  const [editingFn, setEditingFn] = useState<{ id?: string; name: string; code: string; examples: string; sort_order: number } | null>(null);
  const [savingFn, setSavingFn] = useState(false);
  const [deletingFnId, setDeletingFnId] = useState<string | null>(null);

  const startAddFunction = () => {
    setEditingFn({ name: '', code: '', examples: '', sort_order: jobFunctions.length + 1 });
  };

  const startEditFunction = (fn: any) => {
    setEditingFn({
      id: fn.id,
      name: fn.name,
      code: fn.code,
      examples: (fn.examples ?? []).join(', '),
      sort_order: fn.sort_order ?? 0,
    });
  };

  const saveFunction = async () => {
    if (!editingFn) return;
    if (!editingFn.name.trim() || !editingFn.code.trim()) {
      toast.error('Name and code are required');
      return;
    }
    setSavingFn(true);
    try {
      const examplesArr = editingFn.examples
        .split(',')
        .map(e => e.trim())
        .filter(Boolean);
      const payload = {
        name: editingFn.name.trim(),
        code: editingFn.code.trim().toUpperCase(),
        examples: examplesArr,
        sort_order: editingFn.sort_order,
      };

      if (editingFn.id) {
        const { error } = await supabase.from('job_functions').update(payload).eq('id', editingFn.id);
        if (error) throw error;
        toast.success('Function updated');
      } else {
        const { error } = await supabase.from('job_functions').insert(payload);
        if (error) throw error;
        toast.success('Function created');
      }
      queryClient.invalidateQueries({ queryKey: ['job_functions'] });
      setEditingFn(null);
    } catch (err: any) {
      toast.error(err.message || 'Failed to save function');
    } finally {
      setSavingFn(false);
    }
  };

  const deleteFunction = async (fnId: string) => {
    setDeletingFnId(fnId);
    try {
      const { error } = await supabase.from('job_functions').delete().eq('id', fnId);
      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ['job_functions'] });
      toast.success('Function deleted');
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete function');
    } finally {
      setDeletingFnId(null);
    }
  };

  // Microsoft OAuth state
  const [msStatus, setMsStatus] = useState<{
    connected: boolean;
    email_address?: string;
    display_name?: string;
    loading: boolean;
  }>({ connected: false, loading: true });
  const [msConnecting, setMsConnecting] = useState(false);
  const [msDisconnecting, setMsDisconnecting] = useState(false);

  const ADMIN_EMAILS = [
    'chris.sullivan@emeraldrecruit.com',
    'emeraldrecruit@theemeraldrecruitinggroup.com',
  ];
  const isAdmin = ADMIN_EMAILS.includes(user?.email?.toLowerCase() || '');

  // LinkedIn Recruiter connection state
  const [linkedinSeats, setLinkedinSeats] = useState<LinkedinSeat[]>([]);
  const [linkedinSeatsLoading, setLinkedinSeatsLoading] = useState(false);
  const [selectedLinkedinSeatId, setSelectedLinkedinSeatId] = useState('');
  const [liHostedConnectingId, setLiHostedConnectingId] = useState<string | null>(null);
  const [liCookieConnecting, setLiCookieConnecting] = useState(false);
  const [liReverifyingId, setLiReverifyingId] = useState<string | null>(null);
  const [liCookieForm, setLiCookieForm] = useState({
    contract_name: '',
    li_a: '',
    li_at: '',
    proxy_country: 'US',
    user_agent: typeof window !== 'undefined' ? navigator.userAgent : '',
  });

  // Password visibility
  const [showPasswords, setShowPasswords] = useState<Record<string, boolean>>({});

  const togglePassword = (key: string) =>
    setShowPasswords((prev) => ({ ...prev, [key]: !prev[key] }));

  // Enrichment-provider API keys (live in app_settings — Apollo + the
  // four Phase 2/3 providers). One state object so a single save
  // handler covers all of them.
  type EnrichmentKey =
    | 'APOLLO_API_KEY'
    | 'BETTERCONTACT_API_KEY'
    | 'FULLENRICH_API_KEY'
    | 'PDL_API_KEY'
    | 'ZEROBOUNCE_API_KEY';
  const ENRICHMENT_KEY_META: Record<EnrichmentKey, { label: string; help: string; signupUrl: string }> = {
    APOLLO_API_KEY: {
      label: 'Apollo',
      help: 'People match + organization enrich + person_id capture',
      signupUrl: 'https://app.apollo.io/#/settings/integrations/api',
    },
    BETTERCONTACT_API_KEY: {
      label: 'BetterContact',
      help: 'Waterfall for work email + mobile (verifies upstream)',
      signupUrl: 'https://bettercontact.rocks/api',
    },
    FULLENRICH_API_KEY: {
      label: 'FullEnrich',
      help: 'Primary for personal email, secondary for work email',
      signupUrl: 'https://app.fullenrich.com/settings/api',
    },
    PDL_API_KEY: {
      label: 'People Data Labs',
      help: 'Personal email + mobile fallback; company job postings',
      signupUrl: 'https://dashboard.peopledatalabs.com/api-keys',
    },
    ZEROBOUNCE_API_KEY: {
      label: 'ZeroBounce',
      help: 'Verifies Apollo + PDL emails before writing',
      signupUrl: 'https://www.zerobounce.net/members/settings/api/',
    },
  };
  const [enrichmentKeys, setEnrichmentKeys] = useState<Record<EnrichmentKey, string>>({
    APOLLO_API_KEY: '',
    BETTERCONTACT_API_KEY: '',
    FULLENRICH_API_KEY: '',
    PDL_API_KEY: '',
    ZEROBOUNCE_API_KEY: '',
  });
  const [enrichmentKeysLoaded, setEnrichmentKeysLoaded] = useState(false);

  useEffect(() => {
    if (activeTab !== 'api' || enrichmentKeysLoaded) return;
    (async () => {
      const { data } = await supabase
        .from('app_settings')
        .select('key, value')
        .in('key', Object.keys(ENRICHMENT_KEY_META));
      const next = { ...enrichmentKeys };
      for (const row of data ?? []) {
        if (row.key in next) (next as any)[row.key] = row.value ?? '';
      }
      setEnrichmentKeys(next);
      setEnrichmentKeysLoaded(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // ── Scheduling (Calendly-style self-booking link) ──────────────────
  // One link per recruiter. Loaded on tab open; created lazily on first
  // save via POST /api/schedule-links.
  type WorkingWindow = { start: string; end: string };
  type SchedulingLink = {
    id: string;
    slug: string;
    title: string | null;
    duration_min: number;
    meeting_type: 'phone' | 'teams' | 'in_person';
    location: string | null;
    timezone: string;
    working_hours: Record<string, WorkingWindow[]>;
    buffer_min: number;
    min_notice_hours: number;
    max_days_out: number;
    active: boolean;
  };
  const SCHEDULE_DAYS: { key: string; label: string }[] = [
    { key: 'monday', label: 'Mon' },
    { key: 'tuesday', label: 'Tue' },
    { key: 'wednesday', label: 'Wed' },
    { key: 'thursday', label: 'Thu' },
    { key: 'friday', label: 'Fri' },
    { key: 'saturday', label: 'Sat' },
    { key: 'sunday', label: 'Sun' },
  ];
  const COMMON_TIMEZONES = [
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'America/Phoenix',
    'Europe/London',
  ];
  const [schedLink, setSchedLink] = useState<SchedulingLink | null>(null);
  const [schedLoaded, setSchedLoaded] = useState(false);
  const [schedSaving, setSchedSaving] = useState(false);

  useEffect(() => {
    if (activeTab !== 'scheduling' || schedLoaded) return;
    (async () => {
      try {
        const res = await fetch('/api/schedule-links', { headers: await authHeaders() });
        const data = await res.json();
        if (res.ok && Array.isArray(data.links) && data.links.length > 0) {
          setSchedLink(data.links[0] as SchedulingLink);
        }
      } catch {
        // leave null — first save creates the link
      } finally {
        setSchedLoaded(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Default working-hours shape used before a link exists (Mon–Fri 9–5).
  const defaultWorkingHours: Record<string, WorkingWindow[]> = {
    monday: [{ start: '09:00', end: '17:00' }],
    tuesday: [{ start: '09:00', end: '17:00' }],
    wednesday: [{ start: '09:00', end: '17:00' }],
    thursday: [{ start: '09:00', end: '17:00' }],
    friday: [{ start: '09:00', end: '17:00' }],
    saturday: [],
    sunday: [],
  };

  const schedDraft: SchedulingLink = schedLink ?? {
    id: '',
    slug: '',
    title: '',
    duration_min: 30,
    meeting_type: 'phone',
    location: '',
    timezone: 'America/New_York',
    working_hours: defaultWorkingHours,
    buffer_min: 0,
    min_notice_hours: 12,
    max_days_out: 21,
    active: true,
  };

  const updateSchedDraft = (patch: Partial<SchedulingLink>) => {
    setSchedLink((prev) => ({ ...(prev ?? schedDraft), ...patch }));
  };

  const toggleSchedDay = (dayKey: string, enabled: boolean) => {
    const wh = { ...(schedDraft.working_hours ?? {}) };
    wh[dayKey] = enabled ? [{ start: '09:00', end: '17:00' }] : [];
    updateSchedDraft({ working_hours: wh });
  };

  const updateSchedDayWindow = (dayKey: string, field: 'start' | 'end', value: string) => {
    const wh = { ...(schedDraft.working_hours ?? {}) };
    const win = wh[dayKey]?.[0] ?? { start: '09:00', end: '17:00' };
    wh[dayKey] = [{ ...win, [field]: value }];
    updateSchedDraft({ working_hours: wh });
  };

  const saveScheduling = async () => {
    setSchedSaving(true);
    try {
      const exists = !!schedLink?.id;
      const payload = {
        title: schedDraft.title,
        duration_min: schedDraft.duration_min,
        meeting_type: schedDraft.meeting_type,
        location: schedDraft.location,
        timezone: schedDraft.timezone,
        working_hours: schedDraft.working_hours,
        buffer_min: schedDraft.buffer_min,
        min_notice_hours: schedDraft.min_notice_hours,
        max_days_out: schedDraft.max_days_out,
        active: schedDraft.active,
        ...(exists ? { id: schedLink!.id } : {}),
      };
      const res = await fetch('/api/schedule-links', {
        method: exists ? 'PATCH' : 'POST',
        headers: await authHeaders(),
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      setSchedLink(data.link as SchedulingLink);
      toast.success('Scheduling settings saved');
    } catch (err: any) {
      toast.error(err.message || 'Failed to save scheduling settings');
    } finally {
      setSchedSaving(false);
    }
  };

  const bookingUrl = schedLink?.slug
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}/book/${schedLink.slug}`
    : '';

  // Lead Search Filter — natural-language job spec + AI-translated
  // PDL filter JSON. Loaded on tab open.
  const [jobSpecText, setJobSpecText] = useState('');
  const [jobSpecFilters, setJobSpecFilters] = useState<any>({});
  const [jobSpecLastTranslated, setJobSpecLastTranslated] = useState<string | null>(null);
  const [jobSpecLoaded, setJobSpecLoaded] = useState(false);
  const [jobSpecTranslating, setJobSpecTranslating] = useState(false);

  useEffect(() => {
    if (activeTab !== 'job_spec' || jobSpecLoaded) return;
    (async () => {
      const { data } = await supabase
        .from('app_settings')
        .select('key, value')
        .in('key', ['JOB_SPEC_NATURAL_LANGUAGE', 'JOB_SPEC_PDL_FILTERS', 'JOB_SPEC_LAST_TRANSLATED_AT']);
      for (const row of data ?? []) {
        if (row.key === 'JOB_SPEC_NATURAL_LANGUAGE') setJobSpecText(row.value ?? '');
        if (row.key === 'JOB_SPEC_PDL_FILTERS') {
          try { setJobSpecFilters(row.value ? JSON.parse(row.value) : {}); }
          catch { setJobSpecFilters({}); }
        }
        if (row.key === 'JOB_SPEC_LAST_TRANSLATED_AT') {
          setJobSpecLastTranslated(row.value || null);
        }
      }
      setJobSpecLoaded(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  const translateJobSpec = async (save: boolean) => {
    setJobSpecTranslating(true);
    try {
      const res = await fetch('/api/settings/translate-job-spec', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ spec: jobSpecText, save }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Translation failed');
      setJobSpecFilters(data.filters ?? {});
      if (save) {
        setJobSpecLastTranslated(new Date().toISOString());
        toast.success('Job spec saved — applies to all future fetches');
      } else {
        toast.success('Preview generated');
      }
    } catch (err: any) {
      toast.error(err.message || 'Translation failed');
    } finally {
      setJobSpecTranslating(false);
    }
  };

  const saveEnrichmentKey = async (key: EnrichmentKey) => {
    setSaving(key);
    try {
      const { error } = await supabase.from('app_settings').upsert(
        { key, value: enrichmentKeys[key], updated_at: new Date().toISOString() },
        { onConflict: 'key' },
      );
      if (error) throw error;
      toast.success(`${ENRICHMENT_KEY_META[key].label} key saved`);
    } catch (err: any) {
      toast.error(err.message || 'Failed to save');
    } finally {
      setSaving(null);
    }
  };

  // Load existing settings
  const loadSettings = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('user_integrations')
        .select('integration_type, config, is_active')
        .eq('user_id', user.id);

      if (error) throw error;

      (data as IntegrationRow[])?.forEach((row) => {
        const cfg = (row.config ?? {}) as IntegrationConfig;
        switch (row.integration_type) {
          case 'email_smtp':
            setEmailConfig((prev) => ({ ...prev, ...cfg }));
            setEmailActive(row.is_active);
            break;
          case 'unipile':
            setUnipileConfig((prev) => ({ ...prev, ...cfg }));
            setUnipileActive(row.is_active);
            break;
          case 'ringcentral':
            setRingcentralConfig((prev) => ({ ...prev, ...cfg }));
            setRingcentralActive(row.is_active);
            break;
          case 'email_signature':
            setSignatureConfig((prev) => ({ ...prev, ...cfg }));
            break;
          case 'linkedin_limits':
            setLinkedinLimits((prev) => ({ ...prev, ...cfg }));
            break;
          case 'outlook':
            setOutlookConfig((prev) => ({ ...prev, ...cfg }));
            setOutlookActive(row.is_active);
            break;
          case 'clay_enrichment':
            setClayConfig((prev) => ({ ...prev, ...cfg }));
            setClayActive(row.is_active);
            break;
        }
      });
    } catch (err: any) {
      console.error('Failed to load settings', err);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // Load Microsoft OAuth status
  const loadMsStatus = useCallback(async () => {
    if (!user) return;
    setMsStatus(s => ({ ...s, loading: true }));
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/microsoft-oauth/status`,
        { headers: { Authorization: `Bearer ${session?.access_token}` } }
      );
      const data = await res.json();
      setMsStatus({ ...data, loading: false });
    } catch {
      setMsStatus({ connected: false, loading: false });
    }
  }, [user]);

  useEffect(() => {
    loadMsStatus();
  }, [loadMsStatus]);

  // Handle ?ms_connected=1 or ?ms_error= redirects from OAuth callback
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('ms_connected')) {
      toast.success('Microsoft account connected!');
      loadMsStatus();
      window.history.replaceState({}, '', window.location.pathname);
    } else if (params.get('ms_error')) {
      toast.error(`Microsoft connection failed: ${params.get('ms_error')}`);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [loadMsStatus]);

  const loadLinkedInSeats = useCallback(async () => {
    if (!user) {
      setLinkedinSeats([]);
      setSelectedLinkedinSeatId('');
      return;
    }

    setLinkedinSeatsLoading(true);
    try {
      let query = supabase
        .from('integration_accounts')
        .select('id, account_label, account_type, email_address, is_active, linkedin_capabilities, linkedin_capability, metadata, owner_user_id, unipile_account_id, updated_at')
        .eq('provider', 'linkedin')
        .in('account_type', ['linkedin', 'linkedin_classic', 'linkedin_recruiter'])
        .order('account_label', { ascending: true });

      if (!isAdmin) {
        query = query.eq('owner_user_id', user.id);
      }

      const { data, error } = await query;
      if (error) throw error;

      const seats = ((data ?? []) as any[]).map((row) => ({
        ...row,
        linkedin_capabilities: Array.isArray(row.linkedin_capabilities) ? row.linkedin_capabilities : [],
      })) as LinkedinSeat[];

      setLinkedinSeats(seats);
      setSelectedLinkedinSeatId((prev) => {
        if (prev && seats.some((seat) => seat.id === prev)) return prev;
        const preferred = seats.find((seat) => seat.owner_user_id === user.id) ?? seats[0];
        return preferred?.id ?? '';
      });
    } catch (err) {
      console.error('Failed to load LinkedIn seats', err);
    } finally {
      setLinkedinSeatsLoading(false);
    }
  }, [isAdmin, user]);

  useEffect(() => {
    loadLinkedInSeats();
  }, [loadLinkedInSeats]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('linkedin_connected')) {
      toast.success('LinkedIn auth completed. Syncing the Recruiter account now.');
      loadLinkedInSeats();
      window.history.replaceState({}, '', window.location.pathname);
    } else if (params.get('linkedin_error')) {
      toast.error(`LinkedIn connection failed: ${params.get('linkedin_error')}`);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [loadLinkedInSeats]);

  const connectMicrosoft = async () => {
    setMsConnecting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/microsoft-oauth/authorize`,
        { headers: { Authorization: `Bearer ${session?.access_token}` } }
      );
      const { url, error } = await res.json();
      if (error) throw new Error(error);
      window.location.href = url;
    } catch (err: any) {
      toast.error(err.message || 'Failed to start Microsoft OAuth');
      setMsConnecting(false);
    }
  };

  const selectedLinkedinSeat = linkedinSeats.find((seat) => seat.id === selectedLinkedinSeatId) || null;

  const reverifyLinkedInCapabilities = async () => {
    if (!selectedLinkedinSeat) return;
    setLiReverifyingId(selectedLinkedinSeat.id);
    try {
      const resp = await fetch('/api/admin/resync-linkedin-account', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ integration_account_id: selectedLinkedinSeat.id }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data?.error) throw new Error(data?.error || `HTTP ${resp.status}`);
      const cap = data?.linkedin_capability || 'unknown';
      if (data?.recruiter_enabled) {
        toast.success(`Recruiter API access verified (capability: ${cap}).`);
      } else {
        toast.message(`Re-synced. Capability: ${cap}.`, {
          description: Array.isArray(data?.warnings) && data.warnings.length
            ? data.warnings.join(' • ')
            : 'No Recruiter access detected for this seat.',
        });
      }
      loadLinkedInSeats();
    } catch (err: any) {
      toast.error(err?.message || 'Re-verify failed');
    } finally {
      setLiReverifyingId(null);
    }
  };

  const connectLinkedInRecruiter = async () => {
    const fallbackLabel = user?.email || 'LinkedIn Recruiter';
    setLiHostedConnectingId(selectedLinkedinSeat?.id || 'new');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/connect-linkedin', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session?.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          account_id: selectedLinkedinSeat?.unipile_account_id || undefined,
          account_label: selectedLinkedinSeat?.account_label || fallbackLabel,
          contract_name: liCookieForm.contract_name.trim() || undefined,
          integration_account_id: selectedLinkedinSeat?.id || undefined,
          owner_user_id: selectedLinkedinSeat?.owner_user_id || user?.id,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.body || `API ${res.status}`);
      window.location.href = data.url;
    } catch (err: any) {
      toast.error(err.message || 'Failed to start LinkedIn auth');
      setLiHostedConnectingId(null);
    }
  };

  const connectLinkedInWithCookies = async () => {
    if (!liCookieForm.li_at.trim()) {
      toast.error('Paste the li_at cookie first.');
      return;
    }
    if (!liCookieForm.user_agent.trim()) {
      toast.error('Paste the browser user agent first.');
      return;
    }

    const fallbackLabel = user?.email || 'LinkedIn Recruiter';
    setLiCookieConnecting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/connect-linkedin-cookies', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session?.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          account_id: selectedLinkedinSeat?.unipile_account_id || undefined,
          account_label: selectedLinkedinSeat?.account_label || fallbackLabel,
          contract_name: liCookieForm.contract_name.trim() || undefined,
          integration_account_id: selectedLinkedinSeat?.id || undefined,
          li_a: liCookieForm.li_a.trim() || undefined,
          li_at: liCookieForm.li_at.trim(),
          owner_user_id: selectedLinkedinSeat?.owner_user_id || user?.id,
          proxy_country: liCookieForm.proxy_country.trim() || 'US',
          user_agent: liCookieForm.user_agent.trim(),
        }),
      });
      const data = await res.json();

      if (res.status === 202 || data.requires_action) {
        throw new Error('LinkedIn requested an extra checkpoint. Use the hosted auth option or refresh the cookies and try again.');
      }
      if (!res.ok) throw new Error(data.error || `API ${res.status}`);

      if (Array.isArray(data.warnings) && data.warnings.length > 0) {
        toast.warning(data.warnings[0]);
      }
      toast.success(
        data.recruiter_enabled
          ? 'LinkedIn Recruiter connected.'
          : 'LinkedIn connected, but Recruiter access is not verified yet.',
      );
      setLiCookieForm((current) => ({
        ...current,
        li_a: '',
        li_at: '',
      }));
      loadLinkedInSeats();
    } catch (err: any) {
      toast.error(err.message || 'Failed to connect LinkedIn with cookies');
    } finally {
      setLiCookieConnecting(false);
    }
  };

  const disconnectMicrosoft = async () => {
    setMsDisconnecting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/microsoft-oauth/disconnect`,
        { method: 'POST', headers: { Authorization: `Bearer ${session?.access_token}` } }
      );
      setMsStatus({ connected: false, loading: false });
      toast.success('Microsoft account disconnected');
    } catch (err: any) {
      toast.error(err.message || 'Failed to disconnect');
    } finally {
      setMsDisconnecting(false);
    }
  };

  // Upsert helper
  const saveIntegration = async (
    type: string,
    config: IntegrationConfig,
    isActive: boolean
  ) => {
    if (!user) {
      toast.error('You must be logged in to save settings');
      return;
    }
    setSaving(type);
    try {
      const { error } = await supabase
        .from('user_integrations')
        .upsert(
          {
            user_id: user.id,
            integration_type: type,
            config: config as any,
            is_active: isActive,
          },
          { onConflict: 'user_id,integration_type' }
        );

      if (error) throw error;

      // Sync Clay settings to app_settings so Trigger.dev tasks can read them
      if (type === 'clay_enrichment') {
        const appSettingsMap: Record<string, string> = {
          CLAY_ENRICHMENT_ENABLED: isActive ? 'true' : 'false',
          CLAY_API_KEY: config.api_key || '',
          CLAY_WEBHOOK_URL_CANDIDATES: config.webhook_url_candidates || '',
          CLAY_WEBHOOK_URL_CONTACTS: config.webhook_url_contacts || '',
          CLAY_TABLE_ID_CANDIDATES: config.table_id_candidates || '',
          CLAY_TABLE_ID_CONTACTS: config.table_id_contacts || '',
        };
        for (const [key, value] of Object.entries(appSettingsMap)) {
          await supabase.from('app_settings').upsert(
            { key, value, updated_at: new Date().toISOString() },
            { onConflict: 'key' }
          );
        }
      }

      toast.success('Settings saved');
    } catch (err: any) {
      console.error('Save error', err);
      toast.error(err.message || 'Failed to save');
    } finally {
      setSaving(null);
    }
  };

  const loadSignatureTemplate = () => {
    if (signatureConfig.signature_mode === 'html') {
      const template = `<table cellpadding="0" cellspacing="0" style="font-family: Arial, sans-serif; font-size: 13px; color: #333;">
  <tr>
    <td style="padding-right: 16px; border-right: 2px solid #b8860b;">
      <strong style="font-size: 15px; color: #1a3a1a;">Your Name</strong><br/>
      <span style="color: #666;">Senior Recruiter</span><br/>
      <span style="color: #666;">Your Company</span>
    </td>
    <td style="padding-left: 16px;">
      <span>📞 (555) 123-4567</span><br/>
      <span>✉️ you@company.com</span><br/>
      <a href="https://linkedin.com/in/yourprofile" style="color: #0077b5; text-decoration: none;">LinkedIn Profile</a>
    </td>
  </tr>
</table>`;
      setSignatureConfig(c => ({ ...c, signature_html: template }));
    } else {
      const template = `Your Name
Senior Recruiter | Your Company
📞 (555) 123-4567
✉️ you@company.com
🔗 linkedin.com/in/yourprofile`;
      setSignatureConfig(c => ({ ...c, signature_text: template }));
    }
  };

  /** Convert plain text signature to simple HTML for sending */
  const textToHtml = (text: string): string => {
    return text
      .split('\n')
      .map(line => line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
      .join('<br/>');
  };

  /** Get the final HTML signature (from either mode) for saving */
  const getFinalSignatureHtml = (): string => {
    if (signatureConfig.signature_mode === 'html') return signatureConfig.signature_html;
    return textToHtml(signatureConfig.signature_text);
  };

  const tabs = [
    { id: 'integrations', label: 'Integrations', icon: Link2 },
    { id: 'job_functions', label: 'Job Functions', icon: Briefcase },
    { id: 'templates', label: 'Message Templates', icon: PenLine },
    { id: 'signature', label: 'Email Signature', icon: PenLine },
    { id: 'scheduling', label: 'Scheduling', icon: CalendarClock },
    { id: 'linkedin_safety', label: 'LinkedIn Safety', icon: ShieldCheck },
    { id: 'api', label: 'API Keys', icon: Key },
    { id: 'job_spec', label: 'Lead Search Filter', icon: Target },
    { id: 'general', label: 'General', icon: SettingsIcon },
    ...(isAdmin ? [{ id: 'admin', label: 'Admin Tools', icon: Wrench }] : []),
  ];

  const isSaving = (type: string) => saving === type;

  const dailyConnections = parseInt(linkedinLimits.daily_connections) || 25;
  const weeklyConnections = parseInt(linkedinLimits.weekly_connections) || 100;
  const dailyMessages = parseInt(linkedinLimits.daily_messages) || 50;
  const dailyInmails = parseInt(linkedinLimits.daily_inmails) || 25;
  const dailyTotalActions = parseInt(linkedinLimits.daily_total_actions) || 100;
  const warmupEnabled = linkedinLimits.warmup_enabled === 'true';

  const getSafetyLevel = () => {
    if (dailyConnections <= 25 && dailyTotalActions <= 100) return 'safe';
    if (dailyConnections <= 30 && dailyTotalActions <= 150) return 'moderate';
    return 'aggressive';
  };

  const safetyLevel = getSafetyLevel();

  return (
    <MainLayout>
      <PageHeader
        title="Settings"
        description="Configure integrations and manage your account."
      />

      <div className="p-8">
        <div className="flex gap-8">
          {/* Sidebar */}
          <div className="w-48 shrink-0">
            <nav className="space-y-1">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                    activeTab === tab.id
                      ? 'bg-secondary text-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                >
                  <tab.icon className="h-4 w-4" />
                  {tab.label}
                </button>
              ))}
            </nav>
          </div>

          {/* Content */}
          <div className="flex-1 max-w-3xl">
            {loading ? (
              <div className="flex items-center gap-2 text-muted-foreground py-12">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading settings...
              </div>
            ) : (
              <>
                {/* ============ JOB FUNCTIONS TAB ============ */}
                {activeTab === 'job_functions' && (
                  <div>
                    <div className="mb-6 flex items-center justify-between">
                      <div>
                        <h2 className="text-lg font-semibold text-foreground mb-1">Job Functions</h2>
                        <p className="text-sm text-muted-foreground">
                          Manage job function categories used for generating Job Codes (e.g. TD-001, TECH-002).
                        </p>
                      </div>
                      <Button variant="gold" size="sm" onClick={startAddFunction}>
                        <Plus className="h-4 w-4 mr-1" /> Add Function
                      </Button>
                    </div>

                    {/* Edit / Add form */}
                    {editingFn && (
                      <div className="rounded-lg border border-accent/30 bg-accent/5 p-5 mb-6 space-y-4">
                        <div className="flex items-center justify-between">
                          <h3 className="text-sm font-semibold text-foreground">
                            {editingFn.id ? 'Edit Function' : 'New Function'}
                          </h3>
                          <button onClick={() => setEditingFn(null)} className="text-muted-foreground hover:text-foreground">
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-1.5">
                            <Label className="text-xs">Name *</Label>
                            <Input
                              value={editingFn.name}
                              onChange={e => setEditingFn(prev => prev ? { ...prev, name: e.target.value } : prev)}
                              placeholder="e.g. Trading Desk"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs">Code *</Label>
                            <Input
                              value={editingFn.code}
                              onChange={e => setEditingFn(prev => prev ? { ...prev, code: e.target.value.toUpperCase() } : prev)}
                              placeholder="e.g. TD"
                              maxLength={10}
                            />
                            <p className="text-[10px] text-muted-foreground">Short code used in Job ID (e.g. TD-001)</p>
                          </div>
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Examples (comma-separated)</Label>
                          <Input
                            value={editingFn.examples}
                            onChange={e => setEditingFn(prev => prev ? { ...prev, examples: e.target.value } : prev)}
                            placeholder="e.g. Portfolio Managers, Quantitative Researchers, Data Scientists"
                          />
                          <p className="text-[10px] text-muted-foreground">Example roles shown in dropdowns to help users pick the right function</p>
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Sort Order</Label>
                          <Input
                            type="number"
                            value={editingFn.sort_order}
                            onChange={e => setEditingFn(prev => prev ? { ...prev, sort_order: parseInt(e.target.value) || 0 } : prev)}
                            className="w-24"
                          />
                        </div>
                        <div className="flex justify-end gap-2">
                          <Button variant="ghost" size="sm" onClick={() => setEditingFn(null)}>Cancel</Button>
                          <Button variant="gold" size="sm" onClick={saveFunction} disabled={savingFn}>
                            {savingFn && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
                            {editingFn.id ? 'Save Changes' : 'Create Function'}
                          </Button>
                        </div>
                      </div>
                    )}

                    {/* Functions list */}
                    {jobFunctionsLoading ? (
                      <div className="flex items-center gap-2 text-muted-foreground py-8">
                        <Loader2 className="h-4 w-4 animate-spin" /> Loading functions...
                      </div>
                    ) : jobFunctions.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-border p-8 text-center">
                        <Briefcase className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                        <p className="text-sm text-muted-foreground">No functions yet. Add one to start generating job codes.</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {jobFunctions.map((fn: any) => (
                          <div key={fn.id} className="rounded-lg border border-border bg-card p-4 flex items-start justify-between group">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-xs font-semibold text-accent bg-accent/10 px-1.5 py-0.5 rounded">{fn.code}</span>
                                <h3 className="text-sm font-medium text-foreground">{fn.name}</h3>
                              </div>
                              {fn.examples?.length > 0 && (
                                <p className="text-xs text-muted-foreground mt-1">{fn.examples.join(', ')}</p>
                              )}
                            </div>
                            <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => startEditFunction(fn)}>
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                                onClick={() => deleteFunction(fn.id)}
                                disabled={deletingFnId === fn.id}
                              >
                                {deletingFnId === fn.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* ============ TEMPLATES TAB ============ */}
                {activeTab === 'templates' && (
                  <div className="space-y-4">
                    <div className="mb-4">
                      <h2 className="text-lg font-semibold text-foreground mb-1">Message Templates</h2>
                      <p className="text-sm text-muted-foreground">Create reusable message templates for email, LinkedIn, and SMS outreach.</p>
                    </div>
                    <MessageTemplateManager />
                  </div>
                )}

                {activeTab === 'integrations' && (
                  <div className="space-y-6">
                    <div className="mb-6">
                      <h2 className="text-lg font-semibold text-foreground mb-1">Integrations</h2>
                      <p className="text-sm text-muted-foreground">
                        Connect your email and LinkedIn accounts to send outreach.
                      </p>
                    </div>

                    {/* Email SMTP */}
                    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
                      <div className="flex items-center gap-3">
                        <div className={cn(
                          'flex h-10 w-10 items-center justify-center rounded-lg',
                          emailActive ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'
                        )}>
                          <Mail className="h-5 w-5" />
                        </div>
                        <div className="flex-1">
                          <h3 className="text-sm font-semibold text-foreground">Email (SMTP)</h3>
                          <p className="text-xs text-muted-foreground">
                            Send outreach emails directly from the platform.
                          </p>
                        </div>
                        {emailActive && (
                          <span className="flex items-center gap-1 text-xs text-success">
                            <Check className="h-3.5 w-3.5" /> Connected
                          </span>
                        )}
                      </div>

                      <div className="grid grid-cols-1 gap-4">
                        <div className="space-y-1.5">
                          <Label className="text-xs">Email Address</Label>
                          <Input
                            type="email"
                            placeholder="you@domain.com"
                            value={emailConfig.smtp_user}
                            onChange={(e) => {
                              setEmailConfig((c) => ({
                                ...c,
                                smtp_user: e.target.value,
                                from_email: e.target.value,
                              }));
                            }}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Password / App Password</Label>
                          <div className="relative">
                            <Input
                              type={showPasswords.smtp_pass ? 'text' : 'password'}
                              placeholder="••••••••"
                              value={emailConfig.smtp_pass}
                              onChange={(e) => setEmailConfig((c) => ({ ...c, smtp_pass: e.target.value }))}
                            />
                            <button
                              type="button"
                              onClick={() => togglePassword('smtp_pass')}
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                            >
                              {showPasswords.smtp_pass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </button>
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">
                            Use an app password if you have 2FA enabled. Configure SMTP settings in Supabase.
                          </p>
                        </div>
                      </div>

                      <div className="flex justify-end">
                        <Button
                          variant="gold"
                          size="sm"
                          disabled={isSaving('email_smtp')}
                          onClick={() => saveIntegration('email_smtp', emailConfig, true)}
                        >
                          {isSaving('email_smtp') ? (
                            <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Saving...</>
                          ) : (
                            'Save Email Settings'
                          )}
                        </Button>
                      </div>
                    </div>

                    {/* Unipile (LinkedIn) */}
                    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
                      <div className="flex items-center gap-3">
                        <div className={cn(
                          'flex h-10 w-10 items-center justify-center rounded-lg',
                          unipileActive ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'
                        )}>
                          <Linkedin className="h-5 w-5" />
                        </div>
                        <div className="flex-1">
                          <h3 className="text-sm font-semibold text-foreground">Unipile (LinkedIn)</h3>
                          <p className="text-xs text-muted-foreground">
                            Send LinkedIn messages, InMails, and connection requests via Unipile.
                          </p>
                        </div>
                        {unipileActive && (
                          <span className="flex items-center gap-1 text-xs text-success">
                            <Check className="h-3.5 w-3.5" /> Connected
                          </span>
                        )}
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-1.5 col-span-2">
                          <Label className="text-xs">API Key</Label>
                          <div className="relative">
                            <Input
                              type={showPasswords.unipile_key ? 'text' : 'password'}
                              placeholder="Your Unipile API key"
                              value={unipileConfig.api_key}
                              onChange={(e) => setUnipileConfig((c) => ({ ...c, api_key: e.target.value }))}
                            />
                            <button
                              type="button"
                              onClick={() => togglePassword('unipile_key')}
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                            >
                              {showPasswords.unipile_key ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </button>
                          </div>
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Base URL</Label>
                          <Input
                            placeholder="https://api.unipile.com"
                            value={unipileConfig.base_url}
                            onChange={(e) => setUnipileConfig((c) => ({ ...c, base_url: e.target.value }))}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Account ID</Label>
                          <Input
                            placeholder="Your Unipile account ID"
                            value={unipileConfig.account_id}
                            onChange={(e) => setUnipileConfig((c) => ({ ...c, account_id: e.target.value }))}
                          />
                        </div>
                      </div>

                      <div className="flex justify-end">
                        <Button
                          variant="gold"
                          size="sm"
                          disabled={isSaving('unipile')}
                          onClick={() => saveIntegration('unipile', unipileConfig, true)}
                        >
                          {isSaving('unipile') ? (
                            <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Saving...</>
                          ) : (
                            'Save Unipile Settings'
                          )}
                        </Button>
                      </div>
                    </div>

                    {/* RingCentral */}
                    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
                      <div className="flex items-center gap-3">
                        <div className={cn(
                          'flex h-10 w-10 items-center justify-center rounded-lg',
                          ringcentralActive ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'
                        )}>
                          <PhoneCall className="h-5 w-5" />
                        </div>
                        <div className="flex-1">
                          <h3 className="text-sm font-semibold text-foreground">RingCentral</h3>
                          <p className="text-xs text-muted-foreground">
                            Send SMS, make calls, and manage communications via RingCentral.
                          </p>
                        </div>
                        {ringcentralActive && (
                          <span className="flex items-center gap-1 text-xs text-success">
                            <Check className="h-3.5 w-3.5" /> Connected
                          </span>
                        )}
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-1.5">
                          <Label className="text-xs">Client ID</Label>
                          <Input
                            placeholder="Your RingCentral Client ID"
                            value={ringcentralConfig.client_id}
                            onChange={(e) => setRingcentralConfig((c) => ({ ...c, client_id: e.target.value }))}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Client Secret</Label>
                          <div className="relative">
                            <Input
                              type={showPasswords.rc_secret ? 'text' : 'password'}
                              placeholder="••••••••"
                              value={ringcentralConfig.client_secret}
                              onChange={(e) => setRingcentralConfig((c) => ({ ...c, client_secret: e.target.value }))}
                            />
                            <button
                              type="button"
                              onClick={() => togglePassword('rc_secret')}
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                            >
                              {showPasswords.rc_secret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </button>
                          </div>
                        </div>
                        <div className="space-y-1.5 col-span-2">
                          <Label className="text-xs">JWT Token</Label>
                          <div className="relative">
                            <Input
                              type={showPasswords.rc_jwt ? 'text' : 'password'}
                              placeholder="Your JWT credential token"
                              value={ringcentralConfig.jwt_token}
                              onChange={(e) => setRingcentralConfig((c) => ({ ...c, jwt_token: e.target.value }))}
                            />
                            <button
                              type="button"
                              onClick={() => togglePassword('rc_jwt')}
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                            >
                              {showPasswords.rc_jwt ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </button>
                          </div>
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Server URL</Label>
                          <Input
                            placeholder="https://platform.ringcentral.com"
                            value={ringcentralConfig.server_url}
                            onChange={(e) => setRingcentralConfig((c) => ({ ...c, server_url: e.target.value }))}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">SMS Phone Number</Label>
                          <Input
                            placeholder="+15551234567"
                            value={ringcentralConfig.phone_number}
                            onChange={(e) => setRingcentralConfig((c) => ({ ...c, phone_number: e.target.value }))}
                          />
                        </div>
                      </div>

                      <div className="flex justify-end">
                        <Button
                          variant="gold"
                          size="sm"
                          disabled={isSaving('ringcentral')}
                          onClick={() => {
                            const rc = ringcentralConfig;
                            if (!rc.client_id?.trim() || !rc.client_secret?.trim() || !rc.jwt_token?.trim()) {
                              toast.error('Client ID, Client Secret, and JWT Token are required');
                              return;
                            }
                            if (!rc.phone_number?.trim()) {
                              toast.error('SMS Phone Number is required');
                              return;
                            }
                            saveIntegration('ringcentral', ringcentralConfig, true);
                          }}
                        >
                          {isSaving('ringcentral') ? (
                            <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Saving...</>
                          ) : (
                            'Save RingCentral Settings'
                          )}
                        </Button>

                        {/* Backfill historical RC calls — fires the
                            Inngest backfill function with a custom
                            lookback. Pairs with the duration-recon
                            (#261) and 60-min poll lookback (#263)
                            shipped earlier so historical long calls
                            land with correct durations. */}
                        <div className="mt-4 pt-4 border-t border-border space-y-2">
                          <Label className="text-xs font-medium">Backfill historical RC calls</Label>
                          <p className="text-xs text-muted-foreground">
                            Re-fetch your RingCentral call history. Useful when long calls were stranded by the old 10-min poll window. RingCentral retains ~6 months effectively.
                          </p>
                          <div className="flex items-center gap-2">
                            <Select value={backfillRcLookback} onValueChange={setBackfillRcLookback}>
                              <SelectTrigger className="h-9 w-40 text-xs">
                                <SelectValue placeholder="Lookback" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="1">Last 24 hours</SelectItem>
                                <SelectItem value="7">Last 7 days</SelectItem>
                                <SelectItem value="30">Last 30 days</SelectItem>
                                <SelectItem value="90">Last 90 days</SelectItem>
                                <SelectItem value="180">Last 6 months</SelectItem>
                                <SelectItem value="365">Last 365 days</SelectItem>
                              </SelectContent>
                            </Select>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={backfillingRc}
                              onClick={async () => {
                                const days = Number(backfillRcLookback) || 180;
                                const minutes = days * 24 * 60;
                                setBackfillingRc(true);
                                try {
                                  const resp = await fetch('/api/trigger-backfill-rc-calls', {
                                    method: 'POST',
                                    headers: await authHeaders(),
                                    body: JSON.stringify({ lookback_minutes: minutes }),
                                  });
                                  const data = await resp.json().catch(() => ({}));
                                  if (!resp.ok || data?.error) throw new Error(data?.error || `HTTP ${resp.status}`);
                                  toast.success(`Backfill triggered (${days} days). Watch Inngest dashboard for the run.`);
                                } catch (err: any) {
                                  toast.error(err?.message || 'Backfill failed');
                                } finally {
                                  setBackfillingRc(false);
                                }
                              }}
                            >
                              {backfillingRc ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> Triggering...</> : 'Run backfill'}
                            </Button>
                          </div>

                          {/* Re-extract candidate intel from stored
                              call transcripts using the current
                              prompt. Cheap (no Deepgram re-run) — fills
                              in new fields like target_total_comp,
                              urgency, deal_breakers on candidates whose
                              calls predate the richer prompt. */}
                          <div className="mt-4 pt-4 border-t border-border space-y-2">
                            <Label className="text-xs font-medium">Re-extract intel from old calls</Label>
                            <p className="text-xs text-muted-foreground">
                              Re-runs the current AI prompt on already-transcribed calls and refreshes candidate fields (target comp, urgency, deal-breakers, etc.). Skips Deepgram so it's fast and cheap. A cron also runs every 15 min — this button just kicks one off immediately.
                            </p>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={reextractingCalls}
                              onClick={async () => {
                                setReextractingCalls(true);
                                try {
                                  const resp = await fetch('/api/trigger-reextract-call-intel', {
                                    method: 'POST',
                                    headers: await authHeaders(),
                                    body: JSON.stringify({ batch: 50 }),
                                  });
                                  const data = await resp.json().catch(() => ({}));
                                  if (!resp.ok || data?.error) throw new Error(data?.error || `HTTP ${resp.status}`);
                                  toast.success('Re-extraction triggered (batch 50). Candidate fields will refresh as it runs.');
                                } catch (err: any) {
                                  toast.error(err?.message || 'Re-extraction failed');
                                } finally {
                                  setReextractingCalls(false);
                                }
                              }}
                            >
                              {reextractingCalls ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> Triggering...</> : 'Re-extract now'}
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Clay Enrichment */}
                    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
                      <div className="flex items-center gap-3">
                        <div className={cn(
                          'flex h-10 w-10 items-center justify-center rounded-lg',
                          clayActive ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'
                        )}>
                          <Wrench className="h-5 w-5" />
                        </div>
                        <div className="flex-1">
                          <h3 className="text-sm font-semibold text-foreground">Clay Enrichment</h3>
                          <p className="text-xs text-muted-foreground">
                            Enrich candidates &amp; contacts with missing email, phone, and LinkedIn URL via Clay.
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Label htmlFor="clay-toggle" className="text-xs text-muted-foreground">
                            Send to Clay
                          </Label>
                          <Switch
                            id="clay-toggle"
                            checked={clayActive}
                            onCheckedChange={(checked) => {
                              setClayActive(checked);
                              saveIntegration('clay_enrichment', clayConfig, checked);
                            }}
                          />
                        </div>
                      </div>

                      {clayActive && (
                        <div className="space-y-3 pt-2 border-t border-border">
                          <div>
                            <Label className="text-xs text-muted-foreground">Clay API Key</Label>
                            <Input
                              type={showPasswords['clay_api_key'] ? 'text' : 'password'}
                              placeholder="Your Clay API key"
                              value={clayConfig.api_key}
                              onChange={(e) => setClayConfig((c) => ({ ...c, api_key: e.target.value }))}
                              className="mt-1"
                            />
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground">Clay Webhook URL — Candidates</Label>
                            <Input
                              placeholder="https://api.clay.com/v3/sources/webhook/..."
                              value={clayConfig.webhook_url_candidates}
                              onChange={(e) => setClayConfig((c) => ({ ...c, webhook_url_candidates: e.target.value }))}
                              className="mt-1"
                            />
                            <p className="text-[10px] text-muted-foreground mt-1">
                              Paste the full webhook URL from your Clay table's webhook source
                            </p>
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground">Clay Webhook URL — Contacts</Label>
                            <Input
                              placeholder="https://api.clay.com/v3/sources/webhook/..."
                              value={clayConfig.webhook_url_contacts}
                              onChange={(e) => setClayConfig((c) => ({ ...c, webhook_url_contacts: e.target.value }))}
                              className="mt-1"
                            />
                            <p className="text-[10px] text-muted-foreground mt-1">
                              Paste the full webhook URL from your Clay table's webhook source
                            </p>
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground">Clay Table ID — Candidates (for pull)</Label>
                            <Input
                              placeholder="t_0tdejrpM5hBVNVWo5zU"
                              value={clayConfig.table_id_candidates}
                              onChange={(e) => setClayConfig((c) => ({ ...c, table_id_candidates: e.target.value }))}
                              className="mt-1"
                            />
                            <p className="text-[10px] text-muted-foreground mt-1">
                              From the Clay table URL — used to pull enriched data back
                            </p>
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground">Clay Table ID — Contacts (for pull)</Label>
                            <Input
                              placeholder="t_0tdekad8wfsfBYsP6KV"
                              value={clayConfig.table_id_contacts}
                              onChange={(e) => setClayConfig((c) => ({ ...c, table_id_contacts: e.target.value }))}
                              className="mt-1"
                            />
                            <p className="text-[10px] text-muted-foreground mt-1">
                              From the Clay table URL — used to pull enriched data back
                            </p>
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground">Webhook Secret (optional)</Label>
                            <Input
                              type={showPasswords['clay_webhook'] ? 'text' : 'password'}
                              placeholder="Shared secret for webhook validation"
                              value={clayConfig.webhook_secret}
                              onChange={(e) => setClayConfig((c) => ({ ...c, webhook_secret: e.target.value }))}
                              className="mt-1"
                            />
                          </div>
                          <Button
                            variant="gold"
                            size="sm"
                            disabled={isSaving('clay_enrichment')}
                            onClick={() => {
                              if (!clayConfig.api_key?.trim()) {
                                toast.error('Clay API Key is required');
                                return;
                              }
                              saveIntegration('clay_enrichment', clayConfig, clayActive);
                            }}
                          >
                            {isSaving('clay_enrichment') ? (
                              <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Saving...</>
                            ) : (
                              'Save Clay Settings'
                            )}
                          </Button>
                        </div>
                      )}
                    </div>

                    {/* Microsoft / Outlook OAuth */}
                    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
                      <div className="flex items-center gap-3">
                        <div className={cn(
                          'flex h-10 w-10 items-center justify-center rounded-lg',
                          msStatus.connected ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'
                        )}>
                          <Mail className="h-5 w-5" />
                        </div>
                        <div className="flex-1">
                          <h3 className="text-sm font-semibold text-foreground">Outlook / Microsoft 365</h3>
                          <p className="text-xs text-muted-foreground">
                            Connect via OAuth — send &amp; receive emails directly in the inbox.
                          </p>
                        </div>
                        {msStatus.connected && (
                          <span className="flex items-center gap-1 text-xs text-success font-medium">
                            <Check className="h-3.5 w-3.5" /> Connected
                          </span>
                        )}
                      </div>

                      {msStatus.connected ? (
                        <div className="flex items-center justify-between rounded-md bg-muted/40 border border-border px-4 py-3">
                          <div>
                            <p className="text-sm font-medium text-foreground">{msStatus.display_name}</p>
                            <p className="text-xs text-muted-foreground">{msStatus.email_address}</p>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={disconnectMicrosoft}
                            disabled={msDisconnecting}
                            className="text-destructive border-destructive/30 hover:bg-destructive/10"
                          >
                            {msDisconnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Disconnect'}
                          </Button>
                        </div>
                      ) : (
                        <div className="flex flex-col gap-3">
                          <p className="text-xs text-muted-foreground">
                            Sign in with your Microsoft account to enable two-way email sync. Inbound emails will appear in your inbox automatically.
                          </p>
                          <Button
                            variant="gold"
                            size="sm"
                            onClick={connectMicrosoft}
                            disabled={msConnecting || msStatus.loading}
                            className="w-fit"
                          >
                            {msConnecting ? (
                              <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Connecting...</>
                            ) : (
                              'Connect Microsoft Account'
                            )}
                          </Button>
                        </div>
                      )}
                    </div>

                    <div className="rounded-lg border border-border bg-card p-5 space-y-5">
                      <div>
                        <h3 className="text-base font-semibold text-foreground">LinkedIn (Recruiter)</h3>
                        <p className="text-xs text-muted-foreground mt-1">
                          This flow is wired for Unipile Recruiter access. Hosted auth now posts back into Sully Recruit, and the cookie option lets us connect directly with `li_at` + `li_a` for Recruiter-safe auth.
                        </p>
                      </div>

                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        <div className="space-y-1.5">
                          <Label className="text-xs">Recruiter Seat</Label>
                          <Select
                            value={selectedLinkedinSeatId}
                            onValueChange={setSelectedLinkedinSeatId}
                            disabled={linkedinSeatsLoading || linkedinSeats.length === 0}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder={linkedinSeatsLoading ? 'Loading seats...' : 'Select a recruiter seat'} />
                            </SelectTrigger>
                            <SelectContent>
                              {linkedinSeats.map((seat) => (
                                <SelectItem key={seat.id} value={seat.id}>
                                  {seat.account_label || seat.email_address || seat.id}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-1.5">
                          <Label className="text-xs">Recruiter Contract</Label>
                          <Input
                            placeholder="RECRUITER-International Market Recruiters LLC"
                            value={liCookieForm.contract_name}
                            onChange={(e) => setLiCookieForm((c) => ({ ...c, contract_name: e.target.value }))}
                          />
                        </div>
                      </div>

                      {selectedLinkedinSeat && (
                        <div className="rounded-md border border-border bg-muted/30 px-4 py-3 space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-foreground">
                              {selectedLinkedinSeat.account_label || selectedLinkedinSeat.email_address || 'LinkedIn seat'}
                            </span>
                            <Badge variant={selectedLinkedinSeat.account_type === 'linkedin_recruiter' ? 'default' : 'secondary'}>
                              {selectedLinkedinSeat.account_type === 'linkedin_recruiter' ? 'Recruiter' : 'Classic'}
                            </Badge>
                            <Badge variant={selectedLinkedinSeat.is_active ? 'default' : 'secondary'}>
                              {selectedLinkedinSeat.is_active ? 'Active' : 'Disconnected'}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {selectedLinkedinSeat.email_address || 'No email on file'}
                            {selectedLinkedinSeat.unipile_account_id ? ` • ${selectedLinkedinSeat.unipile_account_id}` : ''}
                          </p>
                          {Array.isArray(selectedLinkedinSeat.linkedin_capabilities) && selectedLinkedinSeat.linkedin_capabilities.length > 0 && (
                            <div className="flex flex-wrap gap-2">
                              {selectedLinkedinSeat.linkedin_capabilities.map((capability) => (
                                <Badge key={capability} variant="outline" className="text-[10px] uppercase tracking-wide">
                                  {capability.replace(/_/g, ' ')}
                                </Badge>
                              ))}
                            </div>
                          )}
                          <div className="pt-1">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={reverifyLinkedInCapabilities}
                              disabled={liReverifyingId === selectedLinkedinSeat.id}
                            >
                              {liReverifyingId === selectedLinkedinSeat.id ? (
                                <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Re-verifying...</>
                              ) : (
                                'Re-verify capabilities'
                              )}
                            </Button>
                            <p className="text-[11px] text-muted-foreground mt-1">
                              Pings Unipile to re-check Recruiter API access and refresh the badges above. Use after a manual reconnect.
                            </p>
                          </div>
                        </div>
                      )}

                      <div className="flex flex-wrap gap-3">
                        <Button
                          variant="gold"
                          size="sm"
                          onClick={connectLinkedInRecruiter}
                          disabled={!!liHostedConnectingId}
                        >
                          {liHostedConnectingId ? (
                            <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Opening Hosted Auth...</>
                          ) : (
                            'Reconnect via Hosted Auth'
                          )}
                        </Button>
                        <p className="text-xs text-muted-foreground self-center">
                          Use this when you want Unipile’s own auth page. The callback now syncs the connected Recruiter seat back into `integration_accounts`.
                        </p>
                      </div>

                      <div className="border-t border-border pt-5 space-y-4">
                        <div>
                          <h4 className="text-sm font-semibold text-foreground">Direct Cookie Connection</h4>
                          <p className="text-xs text-muted-foreground mt-1">
                            Recommended for LinkedIn Recruiter. These cookie values are used for this request only; Sully Recruit does not store them in the database.
                          </p>
                        </div>

                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                          <div className="space-y-1.5">
                            <Label className="text-xs">Proxy Country</Label>
                            <Input
                              placeholder="US"
                              value={liCookieForm.proxy_country}
                              onChange={(e) => setLiCookieForm((c) => ({ ...c, proxy_country: e.target.value }))}
                            />
                          </div>
                          <div className="space-y-1.5 md:col-span-2">
                            <Label className="text-xs">User Agent</Label>
                            <Textarea
                              rows={3}
                              placeholder="Mozilla/5.0 ..."
                              value={liCookieForm.user_agent}
                              onChange={(e) => setLiCookieForm((c) => ({ ...c, user_agent: e.target.value }))}
                            />
                          </div>
                          <div className="space-y-1.5 md:col-span-2">
                            <Label className="text-xs">`li_at` Cookie</Label>
                            <Textarea
                              rows={4}
                              placeholder="Paste the main LinkedIn cookie"
                              value={liCookieForm.li_at}
                              onChange={(e) => setLiCookieForm((c) => ({ ...c, li_at: e.target.value }))}
                            />
                          </div>
                          <div className="space-y-1.5 md:col-span-2">
                            <Label className="text-xs">`li_a` Cookie</Label>
                            <Textarea
                              rows={3}
                              placeholder="Paste the premium Recruiter cookie"
                              value={liCookieForm.li_a}
                              onChange={(e) => setLiCookieForm((c) => ({ ...c, li_a: e.target.value }))}
                            />
                          </div>
                        </div>

                        <div className="flex flex-wrap gap-3">
                          <Button
                            variant="gold"
                            size="sm"
                            onClick={connectLinkedInWithCookies}
                            disabled={liCookieConnecting}
                          >
                            {liCookieConnecting ? (
                              <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Connecting...</>
                            ) : (
                              'Connect With Cookies'
                            )}
                          </Button>
                          <p className="text-xs text-muted-foreground self-center">
                            Use both cookies for Recruiter. If Unipile still asks for a checkpoint, fall back to Hosted Auth.
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* ============ EMAIL SIGNATURE TAB ============ */}
                {activeTab === 'signature' && (
                  <div className="space-y-6">
                    <div className="mb-6">
                      <h2 className="text-lg font-semibold text-foreground mb-1">Email Signature</h2>
                      <p className="text-sm text-muted-foreground">
                        This signature will be appended to all outbound emails from sequences when "Include email signature" is enabled on a step.
                      </p>
                    </div>

                    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
                      {/* Mode toggle */}
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 p-1">
                          <button
                            onClick={() => setSignatureConfig(c => ({ ...c, signature_mode: 'text' }))}
                            className={cn(
                              'px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
                              signatureConfig.signature_mode === 'text'
                                ? 'bg-background text-foreground shadow-sm'
                                : 'text-muted-foreground hover:text-foreground'
                            )}
                          >
                            Plain Text
                          </button>
                          <button
                            onClick={() => setSignatureConfig(c => ({ ...c, signature_mode: 'html' }))}
                            className={cn(
                              'px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
                              signatureConfig.signature_mode === 'html'
                                ? 'bg-background text-foreground shadow-sm'
                                : 'text-muted-foreground hover:text-foreground'
                            )}
                          >
                            HTML
                          </button>
                        </div>
                        <Button variant="ghost" size="sm" onClick={loadSignatureTemplate}>
                          <PenLine className="h-3.5 w-3.5 mr-1" />
                          Load template
                        </Button>
                      </div>

                      {signatureConfig.signature_mode === 'html' ? (
                        <Textarea
                          rows={10}
                          placeholder={`<table cellpadding="0" cellspacing="0">\n  <tr>\n    <td>\n      <strong>Your Name</strong><br/>\n      Senior Recruiter | Your Company\n    </td>\n  </tr>\n</table>`}
                          value={signatureConfig.signature_html}
                          onChange={(e) =>
                            setSignatureConfig((c) => ({ ...c, signature_html: e.target.value }))
                          }
                          className="font-mono text-xs"
                        />
                      ) : (
                        <Textarea
                          rows={8}
                          placeholder={`Your Name\nSenior Recruiter | Your Company\n📞 (555) 123-4567\n✉️ you@company.com\n🔗 linkedin.com/in/yourprofile`}
                          value={signatureConfig.signature_text}
                          onChange={(e) =>
                            setSignatureConfig((c) => ({ ...c, signature_text: e.target.value }))
                          }
                          className="text-sm"
                        />
                      )}

                      {/* Preview */}
                      {(signatureConfig.signature_mode === 'html' ? signatureConfig.signature_html : signatureConfig.signature_text) && (
                        <div className="space-y-1.5">
                          <Label className="text-xs">Preview</Label>
                          <div
                            className="rounded-md border border-border bg-background p-4 text-sm text-foreground"
                            dangerouslySetInnerHTML={{ __html: getFinalSignatureHtml() }}
                          />
                        </div>
                      )}

                      <div className="rounded-md border border-border bg-muted/30 p-3">
                        <div className="flex items-start gap-2">
                          <Info className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                          <div className="text-xs text-muted-foreground space-y-1">
                            <p><strong>Recruiter signature tips:</strong></p>
                            <ul className="list-disc list-inside space-y-0.5">
                              <li>Include your direct phone number — candidates prefer real people</li>
                              <li>Add your LinkedIn profile link for credibility</li>
                              <li>Keep it clean — 4-5 lines max</li>
                              {signatureConfig.signature_mode === 'html' && (
                                <li>Add your company logo as a hosted image URL for brand trust</li>
                              )}
                              <li>Include a calendar link (e.g. Calendly) to reduce friction</li>
                            </ul>
                          </div>
                        </div>
                      </div>

                      <div className="flex justify-end">
                        <Button
                          variant="gold"
                          size="sm"
                          disabled={isSaving('email_signature')}
                          onClick={() => {
                            const configToSave = {
                              ...signatureConfig,
                              signature_html: getFinalSignatureHtml(),
                            };
                            saveIntegration('email_signature', configToSave, true);
                          }}
                        >
                          {isSaving('email_signature') ? (
                            <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Saving...</>
                          ) : (
                            'Save Signature'
                          )}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}

                {/* ============ LINKEDIN SAFETY TAB ============ */}
                {activeTab === 'linkedin_safety' && (
                  <div className="space-y-6">
                    <div className="mb-6">
                      <h2 className="text-lg font-semibold text-foreground mb-1">LinkedIn Safety Limits</h2>
                      <p className="text-sm text-muted-foreground">
                        Protect your LinkedIn account from restrictions. These limits apply to all automated sequences.
                      </p>
                    </div>

                    {/* Safety Score */}
                    <div className={cn(
                      'rounded-lg border p-4 flex items-center gap-4',
                      safetyLevel === 'safe' && 'border-success/30 bg-success/5',
                      safetyLevel === 'moderate' && 'border-warning/30 bg-warning/5',
                      safetyLevel === 'aggressive' && 'border-destructive/30 bg-destructive/5',
                    )}>
                      <div className={cn(
                        'flex h-12 w-12 items-center justify-center rounded-full',
                        safetyLevel === 'safe' && 'bg-success/10 text-success',
                        safetyLevel === 'moderate' && 'bg-warning/10 text-warning',
                        safetyLevel === 'aggressive' && 'bg-destructive/10 text-destructive',
                      )}>
                        {safetyLevel === 'aggressive' ? (
                          <AlertTriangle className="h-6 w-6" />
                        ) : (
                          <ShieldCheck className="h-6 w-6" />
                        )}
                      </div>
                      <div>
                        <h3 className={cn(
                          'text-sm font-semibold',
                          safetyLevel === 'safe' && 'text-success',
                          safetyLevel === 'moderate' && 'text-warning',
                          safetyLevel === 'aggressive' && 'text-destructive',
                        )}>
                          {safetyLevel === 'safe' && 'Safe — Low risk of restrictions'}
                          {safetyLevel === 'moderate' && 'Moderate — Watch your acceptance rate'}
                          {safetyLevel === 'aggressive' && 'Aggressive — High risk of LinkedIn restrictions'}
                        </h3>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {safetyLevel === 'safe' && 'Your limits are within LinkedIn best practices for a mature recruiter account.'}
                          {safetyLevel === 'moderate' && 'You\'re near the upper limits. Monitor your connection acceptance rate (keep >40%).'}
                          {safetyLevel === 'aggressive' && 'These limits exceed safe thresholds. You risk temporary or permanent account restrictions.'}
                        </p>
                      </div>
                    </div>

                    {/* Connection Requests */}
                    <div className="rounded-lg border border-border bg-card p-5 space-y-5">
                      <h3 className="text-sm font-semibold text-foreground">Connection Requests</h3>

                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <Label className="text-xs text-muted-foreground">Daily connection requests</Label>
                          <span className="text-sm font-semibold text-foreground">{dailyConnections}/day</span>
                        </div>
                        <Slider
                          value={[dailyConnections]}
                          min={5}
                          max={50}
                          step={5}
                          onValueChange={([v]) => setLinkedinLimits(c => ({ ...c, daily_connections: String(v) }))}
                        />
                        <p className="text-xs text-muted-foreground">
                          Recommended: <strong>20–30/day</strong> for mature accounts. New accounts should start at 5–10.
                        </p>
                      </div>

                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <Label className="text-xs text-muted-foreground">Weekly connection cap</Label>
                          <span className="text-sm font-semibold text-foreground">{weeklyConnections}/week</span>
                        </div>
                        <Slider
                          value={[weeklyConnections]}
                          min={20}
                          max={200}
                          step={10}
                          onValueChange={([v]) => setLinkedinLimits(c => ({ ...c, weekly_connections: String(v) }))}
                        />
                        <p className="text-xs text-muted-foreground">
                          Recommended: <strong>80–120/week</strong>. Target &gt;40% acceptance rate.
                        </p>
                      </div>
                    </div>

                    {/* Messages & InMails */}
                    <div className="rounded-lg border border-border bg-card p-5 space-y-5">
                      <h3 className="text-sm font-semibold text-foreground">Messages & InMails</h3>

                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <Label className="text-xs text-muted-foreground">Daily LinkedIn messages</Label>
                          <span className="text-sm font-semibold text-foreground">{dailyMessages}/day</span>
                        </div>
                        <Slider
                          value={[dailyMessages]}
                          min={10}
                          max={100}
                          step={5}
                          onValueChange={([v]) => setLinkedinLimits(c => ({ ...c, daily_messages: String(v) }))}
                        />
                      </div>

                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <Label className="text-xs text-muted-foreground">Daily InMails (Recruiter)</Label>
                          <span className="text-sm font-semibold text-foreground">{dailyInmails}/day</span>
                        </div>
                        <Slider
                          value={[dailyInmails]}
                          min={5}
                          max={50}
                          step={5}
                          onValueChange={([v]) => setLinkedinLimits(c => ({ ...c, daily_inmails: String(v) }))}
                        />
                      </div>
                    </div>

                    {/* Total Actions */}
                    <div className="rounded-lg border border-border bg-card p-5 space-y-5">
                      <h3 className="text-sm font-semibold text-foreground">Total Daily Actions</h3>

                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <Label className="text-xs text-muted-foreground">Maximum automated actions per 24 hours</Label>
                          <span className={cn(
                            'text-sm font-semibold',
                            dailyTotalActions > 150 ? 'text-destructive' : 'text-foreground'
                          )}>
                            {dailyTotalActions}/day
                          </span>
                        </div>
                        <Slider
                          value={[dailyTotalActions]}
                          min={25}
                          max={250}
                          step={25}
                          onValueChange={([v]) => setLinkedinLimits(c => ({ ...c, daily_total_actions: String(v) }))}
                        />
                        <p className="text-xs text-muted-foreground">
                          Includes invites, messages, follows, endorsements, profile views. Keep under <strong>~150/day</strong> to avoid flags.
                        </p>
                      </div>
                    </div>

                    {/* Warmup */}
                    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="text-sm font-semibold text-foreground">Account Warmup</h3>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Gradually increase daily limits over 2–4 weeks for new or dormant accounts.
                          </p>
                        </div>
                        <Switch
                          checked={warmupEnabled}
                          onCheckedChange={(checked) => setLinkedinLimits(c => ({ ...c, warmup_enabled: String(checked) }))}
                        />
                      </div>
                      {warmupEnabled && (
                        <div className="rounded-md bg-muted/30 border border-border p-3">
                          <p className="text-xs text-muted-foreground">
                            <strong>Warmup schedule:</strong> Start at 30% of your limits → increase by ~15% every 3 days until full capacity (typically 14–21 days). 
                            The system will automatically throttle actions during warmup.
                          </p>
                        </div>
                      )}
                    </div>

                    {/* Best Practices */}
                    <div className="rounded-lg border border-border bg-card p-5 space-y-3">
                      <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                        <Info className="h-4 w-4 text-muted-foreground" />
                        Best Practices for Recruiters
                      </h3>
                      <div className="text-xs text-muted-foreground space-y-2">
                        <div className="grid grid-cols-2 gap-3">
                          <div className="rounded-md bg-muted/30 p-3 space-y-1">
                            <p className="font-semibold text-foreground">🎯 Connection Requests</p>
                            <p>20–30/day, 80–120/week</p>
                            <p>Watch acceptance rate (&gt;40% ideal)</p>
                            <p>Always include a personalized note</p>
                          </div>
                          <div className="rounded-md bg-muted/30 p-3 space-y-1">
                            <p className="font-semibold text-foreground">⚡ Daily Action Limit</p>
                            <p>Keep total under ~150 actions/24hrs</p>
                            <p>Spread actions throughout the day</p>
                            <p>Send between 6 AM – 11 PM local time</p>
                          </div>
                          <div className="rounded-md bg-muted/30 p-3 space-y-1">
                            <p className="font-semibold text-foreground">🔥 New Account Warmup</p>
                            <p>Start with 5–10 requests/day</p>
                            <p>Increase slowly over 2–4 weeks</p>
                            <p>Build organic activity first</p>
                          </div>
                          <div className="rounded-md bg-muted/30 p-3 space-y-1">
                            <p className="font-semibold text-foreground">🛡️ Avoid Restrictions</p>
                            <p>Don't send on weekends excessively</p>
                            <p>Personalize connection notes</p>
                            <p>Pause if acceptance drops below 30%</p>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="flex justify-end">
                      <Button
                        variant="gold"
                        size="sm"
                        disabled={isSaving('linkedin_limits')}
                        onClick={() => saveIntegration('linkedin_limits', linkedinLimits, true)}
                      >
                        {isSaving('linkedin_limits') ? (
                          <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Saving...</>
                        ) : (
                          'Save LinkedIn Limits'
                        )}
                      </Button>
                    </div>
                  </div>
                )}

                {/* ============ SCHEDULING TAB ============ */}
                {activeTab === 'scheduling' && (
                  <div>
                    <div className="mb-6">
                      <h2 className="text-lg font-semibold text-foreground mb-1">Scheduling</h2>
                      <p className="text-sm text-muted-foreground">
                        Share a personal booking page. Invitees pick an open time from your Outlook calendar and the meeting lands on both calendars automatically.
                      </p>
                    </div>

                    {!schedLoaded ? (
                      <div className="flex items-center gap-2 text-muted-foreground py-8">
                        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                      </div>
                    ) : (
                      <div className="space-y-6">
                        {/* Shareable link */}
                        <div className="rounded-lg border border-border bg-card p-5 space-y-3">
                          <div className="flex items-center justify-between">
                            <h3 className="text-sm font-medium text-foreground">Your booking link</h3>
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-muted-foreground">Active</span>
                              <Switch
                                checked={schedDraft.active}
                                onCheckedChange={(v) => updateSchedDraft({ active: v })}
                              />
                            </div>
                          </div>
                          {bookingUrl ? (
                            <div className="flex items-center gap-2">
                              <Input readOnly value={bookingUrl} className="font-mono text-xs" />
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  navigator.clipboard.writeText(bookingUrl);
                                  toast.success('Link copied');
                                }}
                              >
                                <Copy className="h-3.5 w-3.5 mr-1" /> Copy
                              </Button>
                              <a href={bookingUrl} target="_blank" rel="noreferrer">
                                <Button variant="ghost" size="sm">Preview</Button>
                              </a>
                            </div>
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              Save below to generate your link (e.g. <code className="text-[11px]">/book/your-name</code>).
                            </p>
                          )}
                        </div>

                        {/* Meeting details */}
                        <div className="rounded-lg border border-border bg-card p-5 space-y-4">
                          <h3 className="text-sm font-medium text-foreground">Meeting details</h3>
                          <div className="space-y-1.5">
                            <Label className="text-xs">Title</Label>
                            <Input
                              value={schedDraft.title ?? ''}
                              onChange={(e) => updateSchedDraft({ title: e.target.value })}
                              placeholder="Intro call"
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-1.5">
                              <Label className="text-xs">Duration</Label>
                              <Select
                                value={String(schedDraft.duration_min)}
                                onValueChange={(v) => updateSchedDraft({ duration_min: parseInt(v, 10) })}
                              >
                                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  {[15, 20, 30, 45, 60, 90].map((m) => (
                                    <SelectItem key={m} value={String(m)}>{m} minutes</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs">Meeting type</Label>
                              <Select
                                value={schedDraft.meeting_type}
                                onValueChange={(v) => updateSchedDraft({ meeting_type: v as SchedulingLink['meeting_type'] })}
                              >
                                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="phone">Phone call</SelectItem>
                                  <SelectItem value="teams">Microsoft Teams</SelectItem>
                                  <SelectItem value="in_person">In person</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                          </div>
                          {(schedDraft.meeting_type === 'in_person' || schedDraft.meeting_type === 'phone') && (
                            <div className="space-y-1.5">
                              <Label className="text-xs">
                                {schedDraft.meeting_type === 'in_person' ? 'Location' : 'Phone note (optional)'}
                              </Label>
                              <Input
                                value={schedDraft.location ?? ''}
                                onChange={(e) => updateSchedDraft({ location: e.target.value })}
                                placeholder={schedDraft.meeting_type === 'in_person' ? 'Office address' : "We'll call the number you provide"}
                              />
                            </div>
                          )}
                          <div className="space-y-1.5">
                            <Label className="text-xs">Timezone</Label>
                            <Select
                              value={schedDraft.timezone}
                              onValueChange={(v) => updateSchedDraft({ timezone: v })}
                            >
                              <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {COMMON_TIMEZONES.map((tz) => (
                                  <SelectItem key={tz} value={tz}>{tz.replace(/_/g, ' ')}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>

                        {/* Working hours */}
                        <div className="rounded-lg border border-border bg-card p-5 space-y-3">
                          <h3 className="text-sm font-medium text-foreground">Working hours</h3>
                          <p className="text-xs text-muted-foreground">
                            Slots are only offered inside these windows (in your timezone), minus anything already on your calendar.
                          </p>
                          <div className="space-y-2">
                            {SCHEDULE_DAYS.map((day) => {
                              const windows = schedDraft.working_hours?.[day.key] ?? [];
                              const enabled = windows.length > 0;
                              const win = windows[0] ?? { start: '09:00', end: '17:00' };
                              return (
                                <div key={day.key} className="flex items-center gap-3">
                                  <div className="flex items-center gap-2 w-24">
                                    <Switch
                                      checked={enabled}
                                      onCheckedChange={(v) => toggleSchedDay(day.key, v)}
                                    />
                                    <span className="text-sm text-foreground">{day.label}</span>
                                  </div>
                                  {enabled ? (
                                    <div className="flex items-center gap-2">
                                      <Input
                                        type="time"
                                        value={win.start}
                                        onChange={(e) => updateSchedDayWindow(day.key, 'start', e.target.value)}
                                        className="h-8 w-28 text-sm"
                                      />
                                      <span className="text-xs text-muted-foreground">to</span>
                                      <Input
                                        type="time"
                                        value={win.end}
                                        onChange={(e) => updateSchedDayWindow(day.key, 'end', e.target.value)}
                                        className="h-8 w-28 text-sm"
                                      />
                                    </div>
                                  ) : (
                                    <span className="text-xs text-muted-foreground">Unavailable</span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>

                        {/* Booking rules */}
                        <div className="rounded-lg border border-border bg-card p-5 space-y-4">
                          <h3 className="text-sm font-medium text-foreground">Booking rules</h3>
                          <div className="grid grid-cols-3 gap-4">
                            <div className="space-y-1.5">
                              <Label className="text-xs">Buffer (min)</Label>
                              <Input
                                type="number"
                                min={0}
                                value={schedDraft.buffer_min}
                                onChange={(e) => updateSchedDraft({ buffer_min: parseInt(e.target.value) || 0 })}
                                className="h-9"
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs">Min notice (hrs)</Label>
                              <Input
                                type="number"
                                min={0}
                                value={schedDraft.min_notice_hours}
                                onChange={(e) => updateSchedDraft({ min_notice_hours: parseInt(e.target.value) || 0 })}
                                className="h-9"
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs">Days out</Label>
                              <Input
                                type="number"
                                min={1}
                                value={schedDraft.max_days_out}
                                onChange={(e) => updateSchedDraft({ max_days_out: parseInt(e.target.value) || 1 })}
                                className="h-9"
                              />
                            </div>
                          </div>
                        </div>

                        <div className="flex justify-end">
                          <Button variant="gold" size="sm" disabled={schedSaving} onClick={saveScheduling}>
                            {schedSaving ? (
                              <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Saving…</>
                            ) : (
                              'Save Scheduling'
                            )}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ============ API KEYS TAB ============ */}
                {activeTab === 'api' && (
                  <div>
                    <div className="mb-6">
                      <h2 className="text-lg font-semibold text-foreground mb-1">Enrichment provider keys</h2>
                      <p className="text-sm text-muted-foreground">
                        Stored in <code className="text-xs">app_settings</code>. Updates apply instantly — no redeploy needed. Pasted keys are sensitive: rotate at the provider if you ever expose them.
                      </p>
                    </div>
                    <div className="space-y-3">
                      {(Object.keys(ENRICHMENT_KEY_META) as EnrichmentKey[]).map((key) => {
                        const meta = ENRICHMENT_KEY_META[key];
                        const value = enrichmentKeys[key];
                        const isShown = showPasswords[`enrich_${key}`];
                        return (
                          <div key={key} className="rounded-lg border border-border bg-card p-4">
                            <div className="flex items-center justify-between mb-2 gap-3">
                              <div className="min-w-0">
                                <h3 className="text-sm font-medium text-foreground flex items-center gap-2">
                                  {meta.label}
                                  {value && (
                                    <Badge variant="outline" className="text-[10px]">
                                      set ({value.length} chars)
                                    </Badge>
                                  )}
                                </h3>
                                <p className="text-xs text-muted-foreground mt-0.5">{meta.help}</p>
                              </div>
                              <a href={meta.signupUrl} target="_blank" rel="noreferrer"
                                className="text-xs text-accent hover:underline shrink-0">
                                Get key
                              </a>
                            </div>
                            <div className="flex items-center gap-2">
                              <div className="relative flex-1">
                                <Input
                                  type={isShown ? 'text' : 'password'}
                                  value={value}
                                  placeholder="Paste key…"
                                  onChange={(e) =>
                                    setEnrichmentKeys((prev) => ({ ...prev, [key]: e.target.value }))
                                  }
                                  className="h-9 text-sm font-mono pr-9"
                                />
                                <button
                                  type="button"
                                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                  onClick={() => togglePassword(`enrich_${key}`)}
                                >
                                  {isShown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                </button>
                              </div>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => saveEnrichmentKey(key)}
                                disabled={saving === key}
                              >
                                {saving === key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save'}
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* ============ JOB SPEC TAB ============ */}
                {activeTab === 'job_spec' && (
                  <div>
                    <div className="mb-6">
                      <h2 className="text-lg font-semibold text-foreground mb-1">Lead search filter</h2>
                      <p className="text-sm text-muted-foreground">
                        Describe the kinds of jobs the firm cares about in plain English. We translate it to a structured PDL filter that's applied to every bulk "Fetch postings" run — so you don't pull every JP Morgan job, only the ones worth pursuing.
                      </p>
                    </div>

                    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
                      <div>
                        <Label className="text-xs">Spec (free text)</Label>
                        <Textarea
                          value={jobSpecText}
                          onChange={(e) => setJobSpecText(e.target.value)}
                          rows={6}
                          placeholder="e.g. Senior software engineering leaders in financial services (NYC, San Francisco, or remote). Director level or above. Full-time, $200k base minimum. No interns or contract roles."
                          className="mt-1 text-sm font-mono"
                        />
                        <p className="text-[11px] text-muted-foreground mt-1">
                          Tip: be specific about seniority, location, and what to exclude. Vague specs translate to vague filters.
                        </p>
                      </div>

                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={jobSpecTranslating || !jobSpecText.trim()}
                          onClick={() => translateJobSpec(false)}
                        >
                          {jobSpecTranslating ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Target className="h-3.5 w-3.5 mr-1.5" />}
                          Preview filter
                        </Button>
                        <Button
                          size="sm"
                          variant="gold"
                          disabled={jobSpecTranslating}
                          onClick={() => translateJobSpec(true)}
                        >
                          {jobSpecTranslating && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                          Translate & save
                        </Button>
                        {jobSpecLastTranslated && (
                          <span className="text-[11px] text-muted-foreground ml-2">
                            Saved {new Date(jobSpecLastTranslated).toLocaleString()}
                          </span>
                        )}
                      </div>

                      {Object.keys(jobSpecFilters ?? {}).length > 0 && (
                        <div className="pt-3 border-t border-border">
                          <div className="flex items-center justify-between mb-2">
                            <Label className="text-xs">Active PDL filter</Label>
                            <span className="text-[10px] text-muted-foreground">
                              This is what we send to PDL on each fetch
                            </span>
                          </div>
                          <pre className="bg-muted rounded p-3 text-[11px] font-mono whitespace-pre-wrap break-all max-h-64 overflow-y-auto">
                            {JSON.stringify(jobSpecFilters, null, 2)}
                          </pre>
                        </div>
                      )}

                      {Object.keys(jobSpecFilters ?? {}).length === 0 && jobSpecLoaded && (
                        <div className="text-[11px] text-muted-foreground italic">
                          No filter active — every fetch pulls every posting PDL has for the company.
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* ============ ADMIN TOOLS TAB ============ */}
                {activeTab === 'admin' && isAdmin && (
                  <div>
                    <div className="mb-6">
                      <h2 className="text-lg font-semibold text-foreground mb-1">Admin Tools</h2>
                      <p className="text-sm text-muted-foreground">
                        Manually trigger background tasks and scheduled jobs.
                      </p>
                    </div>
                    <div className="space-y-4">
                      {[
                        { id: 'cleanup-stale-enrollments', label: 'Cleanup Enrollments', desc: 'Remove stale/abandoned sequence enrollments', endpoint: null },
                        { id: 'sync-conversations', label: 'Sync Conversations', desc: 'Sync conversations from Unipile', endpoint: null },
                      ].map((task) => (
                        <div key={task.id} className="rounded-lg border border-border bg-card p-4 flex items-center justify-between">
                          <div>
                            <h3 className="text-sm font-medium text-foreground">{task.label}</h3>
                            <p className="text-xs text-muted-foreground">{task.desc}</p>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={saving === task.id}
                            onClick={async () => {
                              if (!task.endpoint) {
                                toast.info(`${task.label} runs on a schedule — trigger it from the Trigger.dev dashboard`);
                                return;
                              }
                              setSaving(task.id);
                              try {
                                const resp = await fetch(task.endpoint, {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({}),
                                });
                                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                                toast.success(`${task.label} triggered`);
                              } catch (err: any) {
                                toast.error(err.message || 'Failed to trigger task');
                              } finally {
                                setSaving(null);
                              }
                            }}
                          >
                            {saving === task.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <><Play className="h-3.5 w-3.5 mr-1" /> Run</>
                            )}
                          </Button>
                        </div>
                      ))}

                      {/* Sweep newly-added people so email + LinkedIn
                          history lands immediately instead of waiting on
                          the hourly cron (50/hr). Fires
                          messages/fetch-entity-history.requested for
                          every person with last_history_synced_at IS NULL,
                          ordered newest-first, capped at 500. */}
                      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
                        <div>
                          <h3 className="text-sm font-medium text-foreground">Backfill messages for recently added people</h3>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Pulls email + LinkedIn history now for every person who's never been synced (newest first). The hourly cron only processes 50 at a time — use this after a wave import.
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Select value={recentPeopleLimit} onValueChange={setRecentPeopleLimit}>
                            <SelectTrigger className="h-9 w-40 text-xs">
                              <SelectValue placeholder="Limit" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="50">Up to 50 people</SelectItem>
                              <SelectItem value="100">Up to 100 people</SelectItem>
                              <SelectItem value="200">Up to 200 people</SelectItem>
                              <SelectItem value="500">Up to 500 people</SelectItem>
                            </SelectContent>
                          </Select>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={backfillingRecentPeople}
                            onClick={async () => {
                              const limit = Number(recentPeopleLimit) || 200;
                              setBackfillingRecentPeople(true);
                              try {
                                const resp = await fetch('/api/trigger-backfill-recent-people', {
                                  method: 'POST',
                                  headers: await authHeaders(),
                                  body: JSON.stringify({ limit }),
                                });
                                const data = await resp.json().catch(() => ({}));
                                if (!resp.ok || data?.error) throw new Error(data?.error || `HTTP ${resp.status}`);
                                if (data?.dispatched > 0) {
                                  toast.success(`Backfill triggered for ${data.dispatched} people. History will land over the next few minutes.`);
                                } else {
                                  toast.info('No unsynced people found — everyone is already up to date.');
                                }
                              } catch (err: any) {
                                toast.error(err?.message || 'Backfill failed');
                              } finally {
                                setBackfillingRecentPeople(false);
                              }
                            }}
                          >
                            {backfillingRecentPeople ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> Triggering...</> : <><Play className="h-3.5 w-3.5 mr-1" /> Run backfill</>}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* ============ GENERAL TAB ============ */}
                {activeTab === 'general' && (
                  <div>
                    <div className="mb-6">
                      <h2 className="text-lg font-semibold text-foreground mb-1">General Settings</h2>
                      <p className="text-sm text-muted-foreground">
                        Configure your account preferences.
                      </p>
                    </div>
                    <div className="space-y-6">
                      <div className="rounded-lg border border-border bg-card p-5">
                        <h3 className="text-sm font-medium text-foreground mb-4">Company Information</h3>
                        <div className="grid gap-4">
                          <div>
                            <Label className="text-xs">Company Name</Label>
                            <Input defaultValue="Sully Recruit" className="mt-1.5" />
                          </div>
                        </div>
                      </div>
                      <div className="flex justify-end">
                        <Button variant="gold">Save Changes</Button>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </MainLayout>
  );
};

export default Settings;
