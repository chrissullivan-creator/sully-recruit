import type { Dispatch, SetStateAction } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { PenLine, Info, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { textToHtml } from '@/components/settings/settings-constants';
import type { IntegrationConfig } from '@/components/settings/settings-types';

interface EmailSignatureSectionProps {
  signatureConfig: IntegrationConfig;
  setSignatureConfig: Dispatch<SetStateAction<IntegrationConfig>>;
  isSaving: (type: string) => boolean;
  saveIntegration: (type: string, config: IntegrationConfig, isActive: boolean) => void;
}

export function EmailSignatureSection({
  signatureConfig,
  setSignatureConfig,
  isSaving,
  saveIntegration,
}: EmailSignatureSectionProps) {
  const loadSignatureTemplate = () => {
    if (signatureConfig.signature_mode === 'html') {
      const template = `<table cellpadding="0" cellspacing="0" style="font-family: Arial, sans-serif; font-size: 13px; color: #333;">
  <tr>
    <td style="padding-right: 16px; border-right: 2px solid #C9A227;">
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

  /** Get the final HTML signature (from either mode) for saving */
  const getFinalSignatureHtml = (): string => {
    if (signatureConfig.signature_mode === 'html') return signatureConfig.signature_html;
    return textToHtml(signatureConfig.signature_text);
  };

  return (
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
  );
}
