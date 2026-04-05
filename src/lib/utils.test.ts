import { describe, it, expect } from 'vitest';
import { cn } from './utils';

describe('cn', () => {
  it('merges class names', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  it('handles conditional classes', () => {
    expect(cn('base', false && 'hidden', 'visible')).toBe('base visible');
  });

  it('deduplicates tailwind classes', () => {
    expect(cn('p-4', 'p-2')).toBe('p-2');
  });

  it('handles empty inputs', () => {
    expect(cn()).toBe('');
    expect(cn('')).toBe('');
    expect(cn(undefined, null)).toBe('');
  });

  it('merges conflicting tailwind utilities', () => {
    expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
  });

  it('preserves non-conflicting classes', () => {
    expect(cn('p-4 text-red-500', 'bg-blue-500')).toBe('p-4 text-red-500 bg-blue-500');
  });
});
