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
  Martini,
  Brain,
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

// ---- component ----
const Settings = () => {
  const { user } = useAuth();
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

  // OpenAI state
  const [openaiConfig, setOpenaiConfig] = useState<IntegrationConfig>({
    api_key: '',
    model: 'gpt-4o',
  });
  const [openaiActive, setOpenaiActive] = useState(false);

  // Email signature
  const [signatureConfig, setSignatureConfig] = useState<IntegrationConfig>({
    signature_html: '',
  });

  // Password visibility
  const [showPasswords, setShowPasswords] = useState<Record<string, boolean>>({});

  const togglePassword = (key: string) =>
    setShowPasswords((prev) => ({ ...prev, [key]: !prev[key] }));

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
          case 'openai':
            setOpenaiConfig((prev) => ({ ...prev, ...cfg }));
            setOpenaiActive(row.is_active);
            break;
          case 'email_signature':
            setSignatureConfig((prev) => ({ ...prev, ...cfg }));
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
      toast.success('Settings saved');
    } catch (err: any) {
      console.error('Save error', err);
      toast.error(err.message || 'Failed to save');
    } finally {
      setSaving(null);
    }
  };

  const tabs = [
    { id: 'integrations', label: 'Integrations', icon: Link2 },
    { id: 'signature', label: 'Email Signature', icon: PenLine },
    { id: 'api', label: 'API Keys', icon: Key },
    { id: 'general', label: 'General', icon: SettingsIcon },
  ];

  const isSaving = (type: string) => saving === type;

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
                {/* ============ INTEGRATIONS TAB ============ */}
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

                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-1.5">
                          <Label className="text-xs">SMTP Host</Label>
                          <Input
                            placeholder="smtp.gmail.com"
                            value={emailConfig.smtp_host}
                            onChange={(e) => setEmailConfig((c) => ({ ...c, smtp_host: e.target.value }))}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">SMTP Port</Label>
                          <Input
                            placeholder="587"
                            value={emailConfig.smtp_port}
                            onChange={(e) => setEmailConfig((c) => ({ ...c, smtp_port: e.target.value }))}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Username / Email</Label>
                          <Input
                            placeholder="you@domain.com"
                            value={emailConfig.smtp_user}
                            onChange={(e) => setEmailConfig((c) => ({ ...c, smtp_user: e.target.value }))}
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
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">From Name</Label>
                          <Input
                            placeholder="John Doe"
                            value={emailConfig.from_name}
                            onChange={(e) => setEmailConfig((c) => ({ ...c, from_name: e.target.value }))}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">From Email</Label>
                          <Input
                            placeholder="john@company.com"
                            value={emailConfig.from_email}
                            onChange={(e) => setEmailConfig((c) => ({ ...c, from_email: e.target.value }))}
                          />
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
                  </div>
                )}

                {/* ============ EMAIL SIGNATURE TAB ============ */}
                {activeTab === 'signature' && (
                  <div className="space-y-6">
                    <div className="mb-6">
                      <h2 className="text-lg font-semibold text-foreground mb-1">Email Signature</h2>
                      <p className="text-sm text-muted-foreground">
                        This signature will be appended to all outbound emails from campaigns.
                      </p>
                    </div>

                    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
                      <div className="space-y-1.5">
                        <Label className="text-xs">Signature (HTML supported)</Label>
                        <Textarea
                          rows={8}
                          placeholder={`Best regards,\nJohn Doe\nSenior Recruiter | Your Company\n\n<a href="https://linkedin.com/in/johndoe">LinkedIn</a>`}
                          value={signatureConfig.signature_html}
                          onChange={(e) =>
                            setSignatureConfig((c) => ({ ...c, signature_html: e.target.value }))
                          }
                        />
                      </div>

                      {signatureConfig.signature_html && (
                        <div className="space-y-1.5">
                          <Label className="text-xs">Preview</Label>
                          <div
                            className="rounded-md border border-border bg-background p-4 text-sm text-foreground prose prose-sm max-w-none"
                            dangerouslySetInnerHTML={{ __html: signatureConfig.signature_html }}
                          />
                        </div>
                      )}

                      <div className="flex justify-end">
                        <Button
                          variant="gold"
                          size="sm"
                          disabled={isSaving('email_signature')}
                          onClick={() => saveIntegration('email_signature', signatureConfig, true)}
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

                {/* ============ API KEYS TAB ============ */}
                {activeTab === 'api' && (
                  <div>
                    <div className="mb-6">
                      <h2 className="text-lg font-semibold text-foreground mb-1">API Keys</h2>
                      <p className="text-sm text-muted-foreground">
                        Manage API keys for external integrations.
                      </p>
                    </div>
                    <div className="rounded-lg border border-border bg-card p-6">
                      <div className="flex items-center justify-between mb-4">
                        <div>
                          <h3 className="text-sm font-medium text-foreground">Production API Key</h3>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Use this key for production integrations
                          </p>
                        </div>
                        <Button size="sm" variant="outline">Generate New Key</Button>
                      </div>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 bg-muted px-3 py-2 rounded text-sm font-mono text-muted-foreground">
                          sk_live_••••••••••••••••••••••••
                        </code>
                        <Button size="sm" variant="ghost">Copy</Button>
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
