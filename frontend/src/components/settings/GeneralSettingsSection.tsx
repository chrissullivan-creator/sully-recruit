import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export function GeneralSettingsSection() {
  return (
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
  );
}
