import { useState } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { 
  Settings as SettingsIcon, 
  Link2, 
  Mail, 
  Phone, 
  Linkedin, 
  Calendar,
  Key,
  Check,
  AlertCircle,
  ExternalLink
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface Integration {
  id: string;
  name: string;
  description: string;
  icon: React.ReactNode;
  connected: boolean;
  status?: 'active' | 'error' | 'pending';
  configFields?: { label: string; placeholder: string; type: 'text' | 'password' }[];
}

const integrations: Integration[] = [
  {
    id: 'unipile',
    name: 'Unipile (LinkedIn)',
    description: 'Sync LinkedIn messages, InMails, and connection requests.',
    icon: <Linkedin className="h-5 w-5" />,
    connected: false,
    configFields: [
      { label: 'API Key', placeholder: 'Enter your Unipile API key', type: 'password' },
      { label: 'Account ID', placeholder: 'Your Unipile account ID', type: 'text' },
    ],
  },
  {
    id: 'ringcentral',
    name: 'RingCentral',
    description: 'Make calls, log recordings, and auto-summarize conversations.',
    icon: <Phone className="h-5 w-5" />,
    connected: true,
    status: 'active',
    configFields: [
      { label: 'Client ID', placeholder: 'RingCentral client ID', type: 'text' },
      { label: 'Client Secret', placeholder: 'Client secret', type: 'password' },
      { label: 'JWT Token', placeholder: 'JWT authentication token', type: 'password' },
    ],
  },
  {
    id: 'email',
    name: 'Email (SMTP/IMAP)',
    description: 'Send and receive emails directly from the platform.',
    icon: <Mail className="h-5 w-5" />,
    connected: true,
    status: 'active',
    configFields: [
      { label: 'SMTP Server', placeholder: 'smtp.gmail.com', type: 'text' },
      { label: 'SMTP Port', placeholder: '587', type: 'text' },
      { label: 'Username', placeholder: 'your-email@domain.com', type: 'text' },
      { label: 'Password', placeholder: 'App password', type: 'password' },
    ],
  },
  {
    id: 'calendly',
    name: 'Calendly',
    description: 'Self-service calendar booking for candidate scheduling.',
    icon: <Calendar className="h-5 w-5" />,
    connected: false,
    configFields: [
      { label: 'API Key', placeholder: 'Calendly API key', type: 'password' },
    ],
  },
];

const Settings = () => {
  const [activeTab, setActiveTab] = useState('integrations');
  const [expandedIntegration, setExpandedIntegration] = useState<string | null>(null);

  const tabs = [
    { id: 'integrations', label: 'Integrations', icon: Link2 },
    { id: 'api', label: 'API Keys', icon: Key },
    { id: 'general', label: 'General', icon: SettingsIcon },
  ];

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
            {activeTab === 'integrations' && (
              <div className="space-y-4">
                <div className="mb-6">
                  <h2 className="text-lg font-semibold text-foreground mb-1">Integrations</h2>
                  <p className="text-sm text-muted-foreground">
                    Connect your tools to sync communications and automate workflows.
                  </p>
                </div>

                {integrations.map((integration) => (
                  <div
                    key={integration.id}
                    className="rounded-lg border border-border bg-card overflow-hidden"
                  >
                    <div 
                      className="flex items-center gap-4 p-4 cursor-pointer hover:bg-muted/50 transition-colors"
                      onClick={() => setExpandedIntegration(
                        expandedIntegration === integration.id ? null : integration.id
                      )}
                    >
                      <div className={cn(
                        'flex h-10 w-10 items-center justify-center rounded-lg',
                        integration.connected ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'
                      )}>
                        {integration.icon}
                      </div>
                      <div className="flex-1">
                        <h3 className="text-sm font-medium text-foreground">{integration.name}</h3>
                        <p className="text-xs text-muted-foreground">{integration.description}</p>
                      </div>
                      <div className="flex items-center gap-3">
                        {integration.connected ? (
                          <span className="flex items-center gap-1 text-xs text-success">
                            <Check className="h-3.5 w-3.5" />
                            Connected
                          </span>
                        ) : (
                          <Button size="sm" variant="gold-outline">
                            Connect
                          </Button>
                        )}
                      </div>
                    </div>

                    {/* Expanded config */}
                    {expandedIntegration === integration.id && integration.configFields && (
                      <div className="border-t border-border p-4 bg-muted/30 space-y-4">
                        {integration.configFields.map((field) => (
                          <div key={field.label}>
                            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                              {field.label}
                            </label>
                            <input
                              type={field.type}
                              placeholder={field.placeholder}
                              className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                            />
                          </div>
                        ))}
                        <div className="flex items-center justify-between pt-2">
                          <a href="#" className="text-xs text-accent hover:underline flex items-center gap-1">
                            View documentation
                            <ExternalLink className="h-3 w-3" />
                          </a>
                          <Button size="sm" variant="gold">
                            Save Configuration
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

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
                      <p className="text-xs text-muted-foreground mt-0.5">Use this key for production integrations</p>
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
                        <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                          Company Name
                        </label>
                        <input
                          type="text"
                          defaultValue="Sully Recruit"
                          className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                          Default Email Signature
                        </label>
                        <textarea
                          rows={3}
                          defaultValue="Best regards,
John Doe
Senior Recruiter | Sully Recruit"
                          className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="flex justify-end">
                    <Button variant="gold">Save Changes</Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </MainLayout>
  );
};

export default Settings;
