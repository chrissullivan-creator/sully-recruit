import { Link } from 'react-router-dom';
import { Copy, AlertTriangle } from 'lucide-react';

export function DataHygieneSection() {
  return (
    <div>
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-foreground mb-1">Data Hygiene</h2>
        <p className="text-sm text-muted-foreground">
          Find and resolve duplicate people and resume/identity collisions.
        </p>
      </div>
      <div className="space-y-4">
        <Link
          to="/duplicates"
          className="block rounded-lg border border-border bg-card p-4 hover:border-accent/40 hover:bg-accent/5 transition-colors"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Copy className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-medium text-foreground">Duplicates</h3>
              <p className="text-xs text-muted-foreground">
                Scan for duplicate people and merge them onto a single record.
              </p>
            </div>
          </div>
        </Link>
        <Link
          to="/admin/collisions"
          className="block rounded-lg border border-border bg-card p-4 hover:border-accent/40 hover:bg-accent/5 transition-colors"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-medium text-foreground">Collisions</h3>
              <p className="text-xs text-muted-foreground">
                Scan for resume/identity collisions where one file maps to multiple people.
              </p>
            </div>
          </div>
        </Link>
      </div>
    </div>
  );
}
