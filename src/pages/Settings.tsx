import { useState, useEffect, useCallback } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
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
  Brain,
  ShieldCheck,
  AlertTriangle,
  Info,
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
          case 'linkedin_limits':
            setLinkedinLimits((prev) => ({ ...prev, ...cfg }));
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
    { id: 'signature', label: 'Email Signature', icon: PenLine },
    { id: 'linkedin_safety', label: 'LinkedIn Safety', icon: ShieldCheck },
    { id: 'api', label: 'API Keys', icon: Key },
    { id: 'general', label: 'General', icon: SettingsIcon },
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

                    {/* OpenAI / ChatGPT */}
                    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
                      <div className="flex items-center gap-3">
                        <div className={cn(
                          'flex h-10 w-10 items-center justify-center rounded-lg',
                          openaiActive ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'
                        )}>
                          <Brain className="h-5 w-5" />
                        </div>
                        <div className="flex-1">
                          <h3 className="text-sm font-semibold text-foreground">OpenAI / ChatGPT</h3>
                          <p className="text-xs text-muted-foreground">
                            Powers Ask Joe AI assistant and sequence step generation.
                          </p>
                        </div>
                        {openaiActive && (
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
                              type={showPasswords.openai_key ? 'text' : 'password'}
                              placeholder="sk-..."
                              value={openaiConfig.api_key}
                              onChange={(e) => setOpenaiConfig((c) => ({ ...c, api_key: e.target.value }))}
                            />
                            <button
                              type="button"
                              onClick={() => togglePassword('openai_key')}
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                            >
                              {showPasswords.openai_key ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </button>
                          </div>
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Model</Label>
                          <Input
                            placeholder="gpt-4o"
                            value={openaiConfig.model}
                            onChange={(e) => setOpenaiConfig((c) => ({ ...c, model: e.target.value }))}
                          />
                        </div>
                      </div>

                      <div className="flex justify-end">
                        <Button
                          variant="gold"
                          size="sm"
                          disabled={isSaving('openai')}
                          onClick={() => saveIntegration('openai', openaiConfig, true)}
                        >
                          {isSaving('openai') ? (
                            <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Saving...</>
                          ) : (
                            'Save OpenAI Settings'
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
                        This signature will be appended to all outbound emails from sequences when "Include email signature" is enabled on a step.
                      </p>
                    </div>

                    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs font-medium">Signature (HTML supported)</Label>
                        <Button variant="ghost" size="sm" onClick={loadSignatureTemplate}>
                          <PenLine className="h-3.5 w-3.5 mr-1" />
                          Load recruiter template
                        </Button>
                      </div>

                      <Textarea
                        rows={10}
                        placeholder={`<table cellpadding="0" cellspacing="0" style="font-family: Arial, sans-serif; font-size: 13px; color: #333;">\n  <tr>\n    <td>\n      <strong>Your Name</strong><br/>\n      Senior Recruiter | Your Company<br/>\n      📞 (555) 123-4567<br/>\n      <a href="https://linkedin.com/in/you">LinkedIn</a>\n    </td>\n  </tr>\n</table>`}
                        value={signatureConfig.signature_html}
                        onChange={(e) =>
                          setSignatureConfig((c) => ({ ...c, signature_html: e.target.value }))
                        }
                        className="font-mono text-xs"
                      />

                      {signatureConfig.signature_html && (
                        <div className="space-y-1.5">
                          <Label className="text-xs">Preview</Label>
                          <div
                            className="rounded-md border border-border bg-background p-4 text-sm text-foreground prose prose-sm max-w-none"
                            dangerouslySetInnerHTML={{ __html: signatureConfig.signature_html }}
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
                              <li>Add your company logo as a hosted image URL for brand trust</li>
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
                          <Label className="text-xs text-muted-foreground">Daily InMails (Recruiter / Sales Nav)</Label>
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
