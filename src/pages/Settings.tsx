import { useState, useEffect, useCallback } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import {
  Mail, Linkedin, PhoneCall, Check, Loader2, Eye, EyeOff,
  Link2, ShieldCheck, User, Info,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// ---- types ----
interface IntegrationConfig {
  [key: string]: string;
}
interface IntegrationRow {
  integration_type: string;
  config: IntegrationConfig;
  is_active: boolean;
}

// ---- Sequence Governor config (hardwired) ----
const GOVERNORS = [
  {
    channel: 'Email',
    Icon: Mail,
    color: 'text-emerald-600',
    dot: 'bg-emerald-500',
    limits: [
      { label: 'Daily send cap', value: '100 emails / day' },
      { label: 'Min gap between sends', value: '8 min' },
      { label: 'Send window', value: '8 am – 5 pm local' },
    ],
  },
  {
    channel: 'LinkedIn',
    Icon: Linkedin,
    color: 'text-blue-600',
    dot: 'bg-blue-500',
    limits: [
      { label: 'Daily connection requests', value: '25 / day' },
      { label: 'Weekly connection cap', value: '100 / week' },
      { label: 'Daily messages', value: '50 / day' },
      { label: 'Daily InMails', value: '25 / day' },
      { label: 'Max total actions', value: '100 / day' },
      { label: 'Min delay between actions', value: '45 sec' },
    ],
  },
  {
    channel: 'SMS',
    Icon: PhoneCall,
    color: 'text-amber-600',
    dot: 'bg-amber-500',
    limits: [
      { label: 'Daily SMS cap', value: '150 / day' },
      { label: 'Min gap between texts', value: '5 min' },
      { label: 'Send window', value: '9 am – 8 pm local' },
    ],
  },
  {
    channel: 'Calls',
    Icon: PhoneCall,
    color: 'text-violet-600',
    dot: 'bg-violet-500',
    limits: [
      { label: 'Daily call attempts', value: '50 / day' },
      { label: 'Max voicemails', value: '20 / day' },
      { label: 'Call window', value: '9 am – 6 pm local' },
    ],
  },
];

// ---- component ----
const Settings = () => {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<'integrations' | 'governors' | 'account'>('integrations');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  // Email SMTP
  const [emailConfig, setEmailConfig] = useState<IntegrationConfig>({
    smtp_host: '', smtp_port: '587', smtp_user: '', smtp_pass: '', from_name: '', from_email: '',
  });
  const [emailActive, setEmailActive] = useState(false);

  // Unipile (LinkedIn)
  const [unipileConfig, setUnipileConfig] = useState<IntegrationConfig>({
    api_key: '', base_url: '', account_id: '',
  });
  const [unipileActive, setUnipileActive] = useState(false);

  // RingCentral
  const [ringcentralConfig, setRingcentralConfig] = useState<IntegrationConfig>({
    client_id: '', client_secret: '', jwt_token: '',
    server_url: 'https://platform.ringcentral.com', phone_number: '',
  });
  const [ringcentralActive, setRingcentralActive] = useState(false);

  // Microsoft OAuth
  const [msStatus, setMsStatus] = useState<{
    connected: boolean; email_address?: string; display_name?: string; loading: boolean;
  }>({ connected: false, loading: true });
  const [msConnecting, setMsConnecting] = useState(false);
  const [msDisconnecting, setMsDisconnecting] = useState(false);

  // Email signature
  const [signatureConfig, setSignatureConfig] = useState<IntegrationConfig>({
    signature_text: '', signature_html: '', signature_mode: 'text',
  });

  // Password reset
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // Password toggles per-field
  const [showPasswords, setShowPasswords] = useState<Record<string, boolean>>({});
  const togglePassword = (key: string) =>
    setShowPasswords((p) => ({ ...p, [key]: !p[key] }));

  // ---- load ----
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
            setEmailConfig((p) => ({ ...p, ...cfg }));
            setEmailActive(row.is_active);
            break;
          case 'unipile':
            setUnipileConfig((p) => ({ ...p, ...cfg }));
            setUnipileActive(row.is_active);
            break;
          case 'ringcentral':
            setRingcentralConfig((p) => ({ ...p, ...cfg }));
            setRingcentralActive(row.is_active);
            break;
          case 'email_signature':
            setSignatureConfig((p) => ({ ...p, ...cfg }));
            break;
        }
      });
    } catch (err: any) {
      console.error('Failed to load settings', err);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  const loadMsStatus = useCallback(async () => {
    if (!user) return;
    setMsStatus((s) => ({ ...s, loading: true }));
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

  useEffect(() => { loadMsStatus(); }, [loadMsStatus]);

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

  // ---- save ----
  const saveIntegration = async (type: string, config: IntegrationConfig, isActive: boolean) => {
    if (!user) { toast.error('You must be logged in'); return; }
    setSaving(type);
    try {
      const { error } = await supabase.from('user_integrations').upsert(
        { user_id: user.id, integration_type: type, config: config as any, is_active: isActive },
        { onConflict: 'user_id,integration_type' }
      );
      if (error) throw error;
      toast.success('Saved');
    } catch (err: any) {
      toast.error(err.message || 'Failed to save');
    } finally {
      setSaving(null);
    }
  };

  // ---- Microsoft OAuth ----
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

  // ---- password change ----
  const handlePasswordChange = async () => {
    if (!newPassword || newPassword !== confirmPassword) {
      toast.error("Passwords don't match");
      return;
    }
    setChangingPassword(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      toast.success('Password updated');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: any) {
      toast.error(err.message || 'Failed to update password');
    } finally {
      setChangingPassword(false);
    }
  };

  // ---- signature helpers ----
  const textToHtml = (text: string) =>
    text.split('\n').map((l) => l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('<br/>');

  const getFinalSignatureHtml = () =>
    signatureConfig.signature_mode === 'html'
      ? signatureConfig.signature_html
      : textToHtml(signatureConfig.signature_text);

  const isSaving = (type: string) => saving === type;

  // ---- tabs ----
  const tabs = [
    { id: 'integrations' as const, label: 'Integrations', Icon: Link2 },
    { id: 'governors' as const, label: 'Sequence Governors', Icon: ShieldCheck },
    { id: 'account' as const, label: 'My Account', Icon: User },
  ];

  return (
    <MainLayout>
      <PageHeader title="Settings" description="Integrations, limits, and account management." />

      <div className="p-8">
        <div className="flex gap-8">
          {/* Sidebar nav */}
          <div className="w-52 shrink-0">
            <nav className="space-y-1">
              {tabs.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  onClick={() => setActiveTab(id)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                    activeTab === id
                      ? 'bg-secondary text-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </button>
              ))}
            </nav>
          </div>

          {/* Main content */}
          <div className="flex-1 max-w-2xl">
            {loading ? (
              <div className="flex items-center gap-2 text-muted-foreground py-12">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : (
              <>
                {/* ======= INTEGRATIONS ======= */}
                {activeTab === 'integrations' && (
                  <div className="space-y-5">
                    <div>
                      <h2 className="text-base font-semibold text-foreground">Integrations</h2>
                      <p className="text-sm text-muted-foreground mt-0.5">
                        Connected accounts used to send outreach.
                      </p>
                    </div>

                    {/* Email SMTP */}
                    <IntegrationCard
                      icon={<Mail className="h-5 w-5" />}
                      title="Email (SMTP)"
                      description="Send outreach emails directly from the platform."
                      active={emailActive}
                    >
                      <div className="space-y-3">
                        <Field label="Email Address">
                          <Input
                            type="email"
                            placeholder="you@domain.com"
                            value={emailConfig.smtp_user}
                            onChange={(e) =>
                              setEmailConfig((c) => ({ ...c, smtp_user: e.target.value, from_email: e.target.value }))
                            }
                          />
                        </Field>
                        <Field label="Password / App Password">
                          <PasswordInput
                            value={emailConfig.smtp_pass}
                            placeholder="••••••••"
                            show={showPasswords.smtp_pass}
                            onToggle={() => togglePassword('smtp_pass')}
                            onChange={(v) => setEmailConfig((c) => ({ ...c, smtp_pass: v }))}
                          />
                        </Field>
                      </div>
                      <SaveButton
                        loading={isSaving('email_smtp')}
                        onClick={() => saveIntegration('email_smtp', emailConfig, true)}
                      />
                    </IntegrationCard>

                    {/* Outlook / Microsoft */}
                    <IntegrationCard
                      icon={<Mail className="h-5 w-5" />}
                      title="Outlook / Microsoft 365"
                      description="Connect via OAuth — two-way email sync."
                      active={msStatus.connected}
                    >
                      {msStatus.loading ? (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking status…
                        </div>
                      ) : msStatus.connected ? (
                        <div className="flex items-center justify-between rounded-md bg-muted/40 border border-border px-4 py-3">
                          <div>
                            <p className="text-sm font-medium">{msStatus.display_name}</p>
                            <p className="text-xs text-muted-foreground">{msStatus.email_address}</p>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={disconnectMicrosoft}
                            disabled={msDisconnecting}
                            className="text-destructive border-destructive/30 hover:bg-destructive/10"
                          >
                            {msDisconnecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Disconnect'}
                          </Button>
                        </div>
                      ) : (
                        <Button
                          variant="gold"
                          size="sm"
                          onClick={connectMicrosoft}
                          disabled={msConnecting}
                          className="w-fit"
                        >
                          {msConnecting ? (
                            <><Loader2 className="h-4 w-4 animate-spin mr-2" />Connecting…</>
                          ) : (
                            'Connect Microsoft Account'
                          )}
                        </Button>
                      )}
                    </IntegrationCard>

                    {/* Unipile */}
                    <IntegrationCard
                      icon={<Linkedin className="h-5 w-5" />}
                      title="Unipile (LinkedIn)"
                      description="Send LinkedIn messages, InMails, and connection requests."
                      active={unipileActive}
                    >
                      <div className="space-y-3">
                        <Field label="API Key">
                          <PasswordInput
                            value={unipileConfig.api_key}
                            placeholder="Your Unipile API key"
                            show={showPasswords.unipile_key}
                            onToggle={() => togglePassword('unipile_key')}
                            onChange={(v) => setUnipileConfig((c) => ({ ...c, api_key: v }))}
                          />
                        </Field>
                        <div className="grid grid-cols-2 gap-3">
                          <Field label="Base URL">
                            <Input
                              placeholder="https://api.unipile.com"
                              value={unipileConfig.base_url}
                              onChange={(e) => setUnipileConfig((c) => ({ ...c, base_url: e.target.value }))}
                            />
                          </Field>
                          <Field label="Account ID">
                            <Input
                              placeholder="Account ID"
                              value={unipileConfig.account_id}
                              onChange={(e) => setUnipileConfig((c) => ({ ...c, account_id: e.target.value }))}
                            />
                          </Field>
                        </div>
                      </div>
                      <SaveButton
                        loading={isSaving('unipile')}
                        onClick={() => saveIntegration('unipile', unipileConfig, true)}
                      />
                    </IntegrationCard>

                    {/* RingCentral */}
                    <IntegrationCard
                      icon={<PhoneCall className="h-5 w-5" />}
                      title="RingCentral"
                      description="SMS outreach and call management."
                      active={ringcentralActive}
                    >
                      <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-3">
                          <Field label="Client ID">
                            <Input
                              placeholder="Client ID"
                              value={ringcentralConfig.client_id}
                              onChange={(e) => setRingcentralConfig((c) => ({ ...c, client_id: e.target.value }))}
                            />
                          </Field>
                          <Field label="Client Secret">
                            <PasswordInput
                              value={ringcentralConfig.client_secret}
                              placeholder="••••••••"
                              show={showPasswords.rc_secret}
                              onToggle={() => togglePassword('rc_secret')}
                              onChange={(v) => setRingcentralConfig((c) => ({ ...c, client_secret: v }))}
                            />
                          </Field>
                        </div>
                        <Field label="JWT Token">
                          <PasswordInput
                            value={ringcentralConfig.jwt_token}
                            placeholder="Your JWT credential token"
                            show={showPasswords.rc_jwt}
                            onToggle={() => togglePassword('rc_jwt')}
                            onChange={(v) => setRingcentralConfig((c) => ({ ...c, jwt_token: v }))}
                          />
                        </Field>
                        <div className="grid grid-cols-2 gap-3">
                          <Field label="Server URL">
                            <Input
                              placeholder="https://platform.ringcentral.com"
                              value={ringcentralConfig.server_url}
                              onChange={(e) => setRingcentralConfig((c) => ({ ...c, server_url: e.target.value }))}
                            />
                          </Field>
                          <Field label="SMS Phone Number">
                            <Input
                              placeholder="+15551234567"
                              value={ringcentralConfig.phone_number}
                              onChange={(e) => setRingcentralConfig((c) => ({ ...c, phone_number: e.target.value }))}
                            />
                          </Field>
                        </div>
                      </div>
                      <SaveButton
                        loading={isSaving('ringcentral')}
                        onClick={() => saveIntegration('ringcentral', ringcentralConfig, true)}
                      />
                    </IntegrationCard>
                  </div>
                )}

                {/* ======= SEQUENCE GOVERNORS ======= */}
                {activeTab === 'governors' && (
                  <div className="space-y-5">
                    <div>
                      <h2 className="text-base font-semibold text-foreground">Sequence Governors</h2>
                      <p className="text-sm text-muted-foreground mt-0.5">
                        System-enforced daily limits applied to all automated sequences.
                      </p>
                    </div>

                    <div className="rounded-lg border border-border bg-muted/20 p-4 flex items-start gap-2.5">
                      <Info className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        These limits are hardwired into the sequence engine to protect your accounts from
                        platform restrictions. They cannot be overridden per-campaign.
                      </p>
                    </div>

                    <div className="grid grid-cols-1 gap-4">
                      {GOVERNORS.map((g) => (
                        <div key={g.channel} className="rounded-lg border border-border bg-card p-5">
                          <div className="flex items-center gap-3 mb-4">
                            <div className={cn('flex h-8 w-8 items-center justify-center rounded-full bg-muted', g.color)}>
                              <g.Icon className="h-4 w-4" />
                            </div>
                            <div className="flex items-center gap-2">
                              <h3 className="text-sm font-semibold text-foreground">{g.channel}</h3>
                              <span className={cn('h-2 w-2 rounded-full', g.dot)} />
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-x-6 gap-y-2.5">
                            {g.limits.map((l) => (
                              <div key={l.label} className="flex items-center justify-between gap-3">
                                <span className="text-xs text-muted-foreground">{l.label}</span>
                                <span className="text-xs font-semibold text-foreground tabular-nums whitespace-nowrap">{l.value}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ======= MY ACCOUNT ======= */}
                {activeTab === 'account' && (
                  <div className="space-y-5">
                    <div>
                      <h2 className="text-base font-semibold text-foreground">My Account</h2>
                      <p className="text-sm text-muted-foreground mt-0.5">
                        Password and email signature settings.
                      </p>
                    </div>

                    {/* Account info */}
                    <div className="rounded-lg border border-border bg-card p-5 space-y-3">
                      <h3 className="text-sm font-semibold text-foreground">Account</h3>
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent/10 text-sm font-semibold text-accent">
                          {user?.email?.slice(0, 2).toUpperCase() ?? '??'}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-foreground">{user?.email}</p>
                          <p className="text-xs text-muted-foreground">Signed in</p>
                        </div>
                      </div>
                    </div>

                    {/* Change password */}
                    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
                      <h3 className="text-sm font-semibold text-foreground">Change Password</h3>
                      <div className="space-y-3">
                        <Field label="New Password">
                          <div className="relative">
                            <Input
                              type={showPassword ? 'text' : 'password'}
                              placeholder="New password"
                              value={newPassword}
                              onChange={(e) => setNewPassword(e.target.value)}
                            />
                            <button
                              type="button"
                              onClick={() => setShowPassword((v) => !v)}
                              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                            >
                              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </button>
                          </div>
                        </Field>
                        <Field label="Confirm Password">
                          <Input
                            type="password"
                            placeholder="Confirm new password"
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handlePasswordChange()}
                          />
                        </Field>
                      </div>
                      <div className="flex justify-end">
                        <Button
                          variant="gold"
                          size="sm"
                          disabled={changingPassword || !newPassword || newPassword !== confirmPassword}
                          onClick={handlePasswordChange}
                        >
                          {changingPassword ? (
                            <><Loader2 className="h-4 w-4 animate-spin mr-1.5" />Updating…</>
                          ) : (
                            'Update Password'
                          )}
                        </Button>
                      </div>
                    </div>

                    {/* Email Signature */}
                    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold text-foreground">Email Signature</h3>
                        {/* Mode toggle */}
                        <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/30 p-0.5">
                          {(['text', 'html'] as const).map((mode) => (
                            <button
                              key={mode}
                              onClick={() => setSignatureConfig((c) => ({ ...c, signature_mode: mode }))}
                              className={cn(
                                'px-3 py-1 text-xs font-medium rounded-md transition-colors capitalize',
                                signatureConfig.signature_mode === mode
                                  ? 'bg-background text-foreground shadow-sm'
                                  : 'text-muted-foreground hover:text-foreground'
                              )}
                            >
                              {mode === 'text' ? 'Plain Text' : 'HTML'}
                            </button>
                          ))}
                        </div>
                      </div>

                      {signatureConfig.signature_mode === 'html' ? (
                        <Textarea
                          rows={8}
                          placeholder={`<strong>Your Name</strong><br/>Senior Recruiter | Your Company`}
                          value={signatureConfig.signature_html}
                          onChange={(e) => setSignatureConfig((c) => ({ ...c, signature_html: e.target.value }))}
                          className="font-mono text-xs resize-none"
                        />
                      ) : (
                        <Textarea
                          rows={6}
                          placeholder={`Your Name\nSenior Recruiter | Your Company\n(555) 123-4567`}
                          value={signatureConfig.signature_text}
                          onChange={(e) => setSignatureConfig((c) => ({ ...c, signature_text: e.target.value }))}
                          className="text-sm resize-none"
                        />
                      )}

                      {/* Live preview */}
                      {(signatureConfig.signature_mode === 'html'
                        ? signatureConfig.signature_html
                        : signatureConfig.signature_text) && (
                        <div>
                          <Label className="text-xs text-muted-foreground mb-1.5 block">Preview</Label>
                          <div
                            className="rounded-md border border-border bg-background px-4 py-3 text-sm text-foreground"
                            dangerouslySetInnerHTML={{ __html: getFinalSignatureHtml() }}
                          />
                        </div>
                      )}

                      <div className="flex justify-end">
                        <Button
                          variant="gold"
                          size="sm"
                          disabled={isSaving('email_signature')}
                          onClick={() =>
                            saveIntegration(
                              'email_signature',
                              { ...signatureConfig, signature_html: getFinalSignatureHtml() },
                              true
                            )
                          }
                        >
                          {isSaving('email_signature') ? (
                            <><Loader2 className="h-4 w-4 animate-spin mr-1.5" />Saving…</>
                          ) : (
                            'Save Signature'
                          )}
                        </Button>
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

// ---- Small reusable sub-components ----

function IntegrationCard({
  icon, title, description, active, children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
      <div className="flex items-center gap-3">
        <div className={cn('flex h-10 w-10 items-center justify-center rounded-lg shrink-0',
          active ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400' : 'bg-muted text-muted-foreground'
        )}>
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        {active && (
          <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 shrink-0 font-medium">
            <Check className="h-3.5 w-3.5" /> Connected
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function PasswordInput({
  value, placeholder, show, onToggle, onChange,
}: {
  value: string;
  placeholder?: string;
  show?: boolean;
  onToggle: () => void;
  onChange: (v: string) => void;
}) {
  return (
    <div className="relative">
      <Input
        type={show ? 'text' : 'password'}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        onClick={onToggle}
        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

function SaveButton({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <div className="flex justify-end pt-1">
      <Button variant="gold" size="sm" disabled={loading} onClick={onClick}>
        {loading ? <><Loader2 className="h-4 w-4 animate-spin mr-1.5" />Saving…</> : 'Save'}
      </Button>
    </div>
  );
}
