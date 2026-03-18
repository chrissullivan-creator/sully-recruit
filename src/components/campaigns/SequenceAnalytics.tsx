import { useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  FunnelChart, Funnel, LabelList, Cell,
} from 'recharts';
import { TrendingUp, Eye, MessageSquare, Send, MousePointerClick } from 'lucide-react';

interface Enrollment {
  id: string;
  status: string;
  current_step_order: number | null;
}

interface StepExecution {
  id: string;
  enrollment_id: string;
  sequence_step_id: string;
  status: string;
  executed_at: string | null;
  delivered_at?: string | null;
  opened_at?: string | null;
  clicked_at?: string | null;
  bounced_at?: string | null;
  open_count?: number;
  click_count?: number;
}

interface Step {
  id: string;
  order: number;
  channel: string;
}

interface SequenceAnalyticsProps {
  steps: Step[];
  enrollments: Enrollment[];
  executions: StepExecution[];
}

const FUNNEL_COLORS = [
  'hsl(var(--primary))',
  'hsl(var(--accent))',
  'hsl(142 76% 36%)',
  'hsl(217 91% 60%)',
  'hsl(45 93% 47%)',
  'hsl(280 67% 51%)',
  'hsl(12 76% 61%)',
  'hsl(173 58% 39%)',
];

export const SequenceAnalytics = ({ steps, enrollments, executions }: SequenceAnalyticsProps) => {
  const metrics = useMemo(() => {
    const totalEnrolled = enrollments.length;
    if (totalEnrolled === 0 || steps.length === 0) return null;

    // Group executions by step
    const stepIdToOrder = new Map(steps.map(s => [s.id, s.order]));

    // Per-step metrics
    const perStep = steps
      .sort((a, b) => a.order - b.order)
      .map((step) => {
        const stepExecs = executions.filter(e => e.sequence_step_id === step.id);
        const sent = stepExecs.filter(e => ['sent','delivered','opened','clicked','complained'].includes(e.status)).length;
        const delivered = stepExecs.filter(e => e.delivered_at || ['delivered','opened','clicked'].includes(e.status)).length;
        const opened = stepExecs.filter(e => e.opened_at || e.status === 'opened' || e.status === 'clicked').length;
        const clicked = stepExecs.filter(e => e.clicked_at || e.status === 'clicked').length;
        const replied = stepExecs.filter(e => e.status === 'replied').length;
        const bounced = stepExecs.filter(e => e.bounced_at || e.status === 'bounced' || e.status === 'failed').length;

        return {
          name: `Step ${step.order}`,
          channel: step.channel,
          sent,
          delivered,
          opened,
          clicked,
          replied,
          bounced,
          deliverRate: sent > 0 ? Math.round((delivered / sent) * 100) : 0,
          openRate: delivered > 0 ? Math.round((opened / delivered) * 100) : 0,
          clickRate: opened > 0 ? Math.round((clicked / opened) * 100) : 0,
          replyRate: sent > 0 ? Math.round((replied / sent) * 100) : 0,
        };
      });

    // Overall stats
    const totalSent = perStep.reduce((a, b) => a + b.sent, 0);
    const totalDelivered = perStep.reduce((a, b) => a + b.delivered, 0);
    const totalOpened = perStep.reduce((a, b) => a + b.opened, 0);
    const totalClicked = perStep.reduce((a, b) => a + b.clicked, 0);
    const totalReplied = perStep.reduce((a, b) => a + b.replied, 0);
    const totalBounced = perStep.reduce((a, b) => a + b.bounced, 0);

    // Funnel data: how many reached each step
    const funnelData = perStep.map((step, i) => {
      // Count enrollees whose current_step_order >= this step order, or who completed/sent this step
      const reached = enrollments.filter(e => (e.current_step_order ?? 1) >= (i + 1)).length;
      return {
        name: step.name,
        value: reached,
        fill: FUNNEL_COLORS[i % FUNNEL_COLORS.length],
      };
    });

    return {
      totalEnrolled,
      totalSent,
      totalDelivered,
      totalOpened,
      totalClicked,
      totalReplied,
      totalBounced,
      overallDeliverRate: totalSent > 0 ? Math.round((totalDelivered / totalSent) * 100) : 0,
      overallOpenRate: totalDelivered > 0 ? Math.round((totalOpened / totalDelivered) * 100) : 0,
      overallClickRate: totalOpened > 0 ? Math.round((totalClicked / totalOpened) * 100) : 0,
      overallReplyRate: totalSent > 0 ? Math.round((totalReplied / totalSent) * 100) : 0,
      perStep,
      funnelData,
    };
  }, [steps, enrollments, executions]);

  if (!metrics) {
    return (
      <div className="rounded-lg border border-border bg-card p-6 text-center">
        <TrendingUp className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
        <p className="text-sm text-muted-foreground">Analytics will appear once candidates are enrolled and steps are executed.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <SummaryCard icon={<Send className="h-4 w-4" />} label="Sent" value={metrics.totalSent} />
        <SummaryCard icon={<TrendingUp className="h-4 w-4" />} label="Delivered" value={metrics.totalDelivered} suffix={`${metrics.overallDeliverRate}%`} />
        <SummaryCard icon={<Eye className="h-4 w-4" />} label="Opened" value={metrics.totalOpened} suffix={`${metrics.overallOpenRate}%`} />
        <SummaryCard icon={<MousePointerClick className="h-4 w-4" />} label="Clicked" value={metrics.totalClicked} suffix={`${metrics.overallClickRate}%`} />
        <SummaryCard icon={<MessageSquare className="h-4 w-4" />} label="Replied" value={metrics.totalReplied} suffix={`${metrics.overallReplyRate}%`} />
        <SummaryCard icon={<TrendingUp className="h-4 w-4" />} label="Bounced" value={metrics.totalBounced} />
      </div>

      {/* Per-Step Bar Chart */}
      <div className="rounded-lg border border-border bg-card p-5">
        <h4 className="text-sm font-semibold text-foreground mb-4">Per-Step Performance</h4>
        {metrics.perStep.some(s => s.sent > 0) ? (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={metrics.perStep} barCategoryGap="20%">
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="name" tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }} />
              <YAxis tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }} />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '8px',
                  fontSize: '12px',
                  color: 'hsl(var(--foreground))',
                }}
              />
              <Bar dataKey="sent" name="Sent" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
              <Bar dataKey="delivered" name="Delivered" fill="hsl(142 76% 36%)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="opened" name="Opened" fill="hsl(var(--accent))" radius={[4, 4, 0, 0]} />
              <Bar dataKey="clicked" name="Clicked" fill="hsl(217 91% 60%)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="replied" name="Replied" fill="hsl(280 67% 51%)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-8">No step executions yet. Data will appear once messages are sent.</p>
        )}
      </div>

      {/* Conversion Funnel */}
      <div className="rounded-lg border border-border bg-card p-5">
        <h4 className="text-sm font-semibold text-foreground mb-4">Step Conversion Funnel</h4>
        {metrics.funnelData.length > 0 && metrics.funnelData[0].value > 0 ? (
          <ResponsiveContainer width="100%" height={280}>
            <FunnelChart>
              <Tooltip
                contentStyle={{
                  backgroundColor: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '8px',
                  fontSize: '12px',
                  color: 'hsl(var(--foreground))',
                }}
              />
              <Funnel dataKey="value" data={metrics.funnelData} isAnimationActive>
                <LabelList position="right" fill="hsl(var(--foreground))" stroke="none" fontSize={12} />
                <LabelList position="center" fill="white" stroke="none" fontSize={11} dataKey="name" />
                {metrics.funnelData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.fill} />
                ))}
              </Funnel>
            </FunnelChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-8">Funnel data will populate as enrollees progress through steps.</p>
        )}
      </div>

      {/* Per-Step Table */}
      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-secondary">
            <tr>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">Step</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">Channel</th>
              <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">Sent</th>
              <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">Delivered</th>
              <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">Opened</th>
              <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">Open %</th>
              <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">Clicked</th>
              <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">Replied</th>
              <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">Bounced</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {metrics.perStep.map((step) => (
              <tr key={step.name} className="hover:bg-muted/50 transition-colors">
                <td className="px-4 py-2.5 font-medium text-foreground">{step.name}</td>
                <td className="px-4 py-2.5 text-muted-foreground capitalize">{step.channel}</td>
                <td className="px-4 py-2.5 text-right text-foreground">{step.sent}</td>
                <td className="px-4 py-2.5 text-right text-foreground">{step.delivered}</td>
                <td className="px-4 py-2.5 text-right text-foreground">{step.opened}</td>
                <td className="px-4 py-2.5 text-right text-accent font-medium">{step.openRate}%</td>
                <td className="px-4 py-2.5 text-right text-foreground">{step.clicked}</td>
                <td className="px-4 py-2.5 text-right text-foreground">{step.replied}</td>
                <td className="px-4 py-2.5 text-right text-destructive font-medium">{step.bounced}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const SummaryCard = ({ icon, label, value, suffix }: { icon: React.ReactNode; label: string; value: number; suffix?: string }) => (
  <div className="rounded-lg border border-border bg-card p-4">
    <div className="flex items-center gap-2 text-muted-foreground mb-1">
      {icon}
      <span className="text-xs">{label}</span>
    </div>
    <p className="text-xl font-bold text-foreground">
      {value}
      {suffix && <span className="text-sm font-normal text-muted-foreground ml-1.5">{suffix}</span>}
    </p>
  </div>
);
