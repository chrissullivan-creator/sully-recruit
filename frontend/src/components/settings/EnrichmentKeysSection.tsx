import type { Dispatch, SetStateAction } from 'react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { ENRICHMENT_KEY_META } from '@/components/settings/settings-constants';
import type { EnrichmentKey } from '@/components/settings/settings-types';

interface EnrichmentKeysSectionProps {
  enrichmentKeys: Record<EnrichmentKey, string>;
  setEnrichmentKeys: Dispatch<SetStateAction<Record<EnrichmentKey, string>>>;
  showPasswords: Record<string, boolean>;
  togglePassword: (key: string) => void;
  saveEnrichmentKey: (key: EnrichmentKey) => void;
  saving: string | null;
}

export function EnrichmentKeysSection({
  enrichmentKeys,
  setEnrichmentKeys,
  showPasswords,
  togglePassword,
  saveEnrichmentKey,
  saving,
}: EnrichmentKeysSectionProps) {
  return (
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
  );
}
