import { describe, it, expect } from 'vitest';
import { buildReceiptPrompt } from '../../../../src/nest/llm-parse/receipt-prompt';

/**
 * A till roll prints "26-08-23" and means one of three things. The merchant's
 * country settles DD/MM vs MM/DD, but nothing printed on the paper settles which
 * pair is the year — a real REDUNIQ slip from a Porto hotel was read as 2023
 * when it was 2026. Telling the model what day it is turns an unanswerable
 * question into an easy one, because a receipt is scanned soon after it is paid.
 */
describe('buildReceiptPrompt — dating an ambiguous receipt', () => {
  it('tells the model what day it is', () => {
    expect(buildReceiptPrompt(new Date('2026-08-24T10:00:00Z'))).toContain('Today is 2026-08-24');
  });

  it('asks for the reading nearest today, and forbids a future one', () => {
    const prompt = buildReceiptPrompt(new Date('2026-08-24T10:00:00Z'));

    expect(prompt).toMatch(/nearest to today/i);
    // A receipt dated ahead of today is never the right reading of an ambiguous
    // one — that is the half of the rule that makes it decidable.
    expect(prompt).toMatch(/never choose one in the future/i);
  });

  it('keeps the country rule for the DD/MM vs MM/DD half of the problem', () => {
    // The two rules answer different questions; neither replaces the other.
    expect(buildReceiptPrompt()).toMatch(/country of the merchant/i);
  });

  it('defaults to the real today, so a caller cannot forget to date it', () => {
    expect(buildReceiptPrompt()).toContain(`Today is ${new Date().toISOString().slice(0, 10)}`);
  });
});
