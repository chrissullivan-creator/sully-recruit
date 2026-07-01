import { describe, expect, it } from 'vitest';
import {
  isInlineExecutableJoeAction,
  isJoeQueueItemVisible,
  isLowRiskBatchAction,
  queueRowToJoeAction,
} from './joeActions';

describe('joe action queue helpers', () => {
  it('maps queue rows into Joe action cards', () => {
    const item = queueRowToJoeAction({
      id: '11111111-1111-4111-8111-111111111111',
      source: 'joe_proposal',
      action_type: 'add_note',
      entity_type: 'candidate',
      entity_id: '22222222-2222-4222-8222-222222222222',
      title: 'Add note to Jane',
      preview: 'Wants rates roles',
      params: { person_id: '22222222-2222-4222-8222-222222222222', note: 'Wants rates roles' },
      route: '/candidates/22222222-2222-4222-8222-222222222222',
      status: 'pending',
      created_at: '2026-07-01T12:00:00.000Z',
      history: [{ at: '2026-07-01T12:00:00.000Z', event: 'proposed', actor: 'joe' }],
    });

    expect(item.type).toBe('add_note');
    expect(item.params.note).toBe('Wants rates roles');
    expect(item.history).toHaveLength(1);
  });

  it('only shows due snoozed items', () => {
    const now = new Date('2026-07-01T12:00:00.000Z');

    expect(isJoeQueueItemVisible({ status: 'pending', snoozed_until: null }, now)).toBe(true);
    expect(isJoeQueueItemVisible({ status: 'done', snoozed_until: null }, now)).toBe(false);
    expect(isJoeQueueItemVisible({ status: 'snoozed', snoozed_until: '2026-07-01T11:59:00.000Z' }, now)).toBe(true);
    expect(isJoeQueueItemVisible({ status: 'snoozed', snoozed_until: '2026-07-02T12:00:00.000Z' }, now)).toBe(false);
  });

  it('separates single approval actions from low-risk batch actions', () => {
    expect(isInlineExecutableJoeAction({ type: 'enroll_in_sequence' })).toBe(true);
    expect(isLowRiskBatchAction({ type: 'enroll_in_sequence' })).toBe(false);
    expect(isLowRiskBatchAction({ type: 'add_note' })).toBe(true);
  });
});
