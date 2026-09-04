import { describe, it, expect } from 'vitest';
import { describeProviderFailure } from '../../../../src/nest/llm-parse/llm-failure';

/**
 * The contract is as much about what does NOT reach the screen as what does: the
 * provider's body is evidence for the log, not text for the person who just
 * photographed a receipt.
 */
describe('describeProviderFailure', () => {
  it('names the setting when the model cannot read images', () => {
    const out = describeProviderFailure(
      new Error(
        'LLM request failed (400): {"error":{"message":"Multimodal data provided, but model does not support multimodal requests.","type":"invalid_request_error"}}'
      )
    );
    expect(out).toMatch(/cannot read images/i);
    expect(out).toMatch(/vision-capable/i);
  });

  it('tells the host to raise the context window when the prompt did not fit', () => {
    const out = describeProviderFailure(
      new Error(
        'LLM request failed (400): {"error":{"message":"request (4825 tokens) exceeds the available context size (4096 tokens), try increasing it","type":"exceed_context_size_error","n_ctx":4096}}'
      )
    );
    expect(out).toMatch(/context window/i);
    expect(out).toMatch(/OLLAMA_CONTEXT_LENGTH/);
  });

  it('points at the API key on an auth rejection', () => {
    expect(describeProviderFailure(new Error('LLM request failed (401): invalid_api_key'))).toMatch(/API key/i);
  });

  it('says to wait when the provider is throttling', () => {
    expect(describeProviderFailure(new Error('LLM request failed (429): rate_limit_exceeded'))).toMatch(/try again/i);
  });

  it('distinguishes a model that never answered from one that refused', () => {
    expect(describeProviderFailure(new Error('The operation was aborted'))).toMatch(/did not answer in time/i);
    expect(describeProviderFailure(new Error('fetch failed: ECONNREFUSED'))).toMatch(/did not answer in time/i);
  });

  it('never puts a provider body on the screen, even for a failure it cannot name', () => {
    const raw = 'LLM request failed (418): {"error":{"message":"teapot","internal_endpoint":"http://10.0.0.4:9000"}}';
    const out = describeProviderFailure(new Error(raw));

    expect(out).toMatch(/server log/i);
    expect(out).not.toMatch(/teapot/);
    expect(out).not.toMatch(/10\.0\.0\.4/);
    expect(out).not.toMatch(/[{}]/);
  });
});
