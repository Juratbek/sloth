import { describe, expect, it } from 'vitest';
import { errorText } from '../src/lib/errors';

describe('errorText', () => {
  it('shows an Error without the "Error:" that String() puts in front of it', () => {
    expect(errorText(new Error('the tunnel is not up'))).toBe('the tunnel is not up');
    expect(errorText(new TypeError('failed to fetch'))).toBe('failed to fetch');
  });

  it('shows a thrown string as it was thrown', () => {
    expect(errorText('cross-site request blocked')).toBe('cross-site request blocked');
  });

  it('takes the message off anything shaped like an error', () => {
    expect(errorText({ message: '403 only from the machine Sloth runs on' })).toBe('403 only from the machine Sloth runs on');
  });

  it('says something rather than nothing about a value it does not know', () => {
    expect(errorText({ status: 500 })).toBe('[object Object]');
    expect(errorText(404)).toBe('404');
  });

  it('has nothing to say about no error at all — the note renders nothing', () => {
    expect(errorText(undefined)).toBe('');
    expect(errorText(null)).toBe('');
  });

  it('falls back to String() for an Error with an empty message, rather than showing a blank', () => {
    expect(errorText(new Error(''))).toBe('Error');
  });
});
