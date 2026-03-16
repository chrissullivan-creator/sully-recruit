export interface ImportReviewLikeRow {
  dedupe_status?: string | null;
  uploader_action?: string | null;
  chosen_candidate_id?: string | null;
  promoted_at?: string | null;
  status?: string | null;
}

export interface FrontendImportState {
  statusKey: string;
  label: string;
  helperText?: string;
  isNeedsReview: boolean;
  isResolved: boolean;
  canReview: boolean;
}

export function isResolvedViaMerge(row: ImportReviewLikeRow): boolean {
  return row.uploader_action === 'merge' && !!row.chosen_candidate_id && !!row.promoted_at;
}

export function getFrontendImportState(row: ImportReviewLikeRow): FrontendImportState {
  if (isResolvedViaMerge(row)) {
    return {
      statusKey: 'merged',
      label: 'Merged',
      helperText: 'Merged into existing candidate',
      isNeedsReview: false,
      isResolved: true,
      canReview: false,
    };
  }

  if (row.dedupe_status === 'review_needed') {
    return {
      statusKey: 'review_needed',
      label: 'Needs Review',
      isNeedsReview: true,
      isResolved: false,
      canReview: true,
    };
  }

  if (row.promoted_at) {
    return {
      statusKey: 'promoted',
      label: 'Promoted',
      isNeedsReview: false,
      isResolved: true,
      canReview: false,
    };
  }

  return {
    statusKey: row.status || 'new',
    label: row.status ? row.status.replace(/_/g, ' ') : 'new',
    isNeedsReview: false,
    isResolved: false,
    canReview: false,
  };
}
