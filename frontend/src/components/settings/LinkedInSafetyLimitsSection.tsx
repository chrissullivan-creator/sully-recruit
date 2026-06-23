import type { Dispatch, SetStateAction } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { AlertTriangle, Info, Loader2, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { IntegrationConfig } from '@/components/settings/settings-types';

interface LinkedInSafetyLimitsSectionProps {
  linkedinLimits: IntegrationConfig;
  setLinkedinLimits: Dispatch<SetStateAction<IntegrationConfig>>;
  isSaving: (type: string) => boolean;
  saveIntegration: (type: string, config: IntegrationConfig, isActive: boolean) => void;
}

export function LinkedInSafetyLimitsSection({
  linkedinLimits,
  setLinkedinLimits,
  isSaving,
  saveIntegration,
}: LinkedInSafetyLimitsSectionProps) {
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
  );
}
