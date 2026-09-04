import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The LLM lane's response ceiling, pinned at the seam where it is actually
 * applied.
 *
 * `createPinnedDispatcher` grew a `responseTimeoutMs` parameter and nothing
 * passed it, so the ceiling stayed undici's default five minutes while the
 * AbortController said fifteen — and a local vision model reading a photograph
 * died at five with nothing to show for the compute. A capability nobody calls
 * looks exactly like a working fix from the outside, which is why this asserts
 * the argument reaches the dispatcher rather than that the option exists.
 */
const { AgentMock } = vi.hoisted(() => ({ AgentMock: vi.fn() }));
vi.mock('undici', () => ({ Agent: AgentMock }));

// ssrfGuard reads env at module load, so the mock must answer before the import.
const { readEnvMock } = vi.hoisted(() => ({
  readEnvMock: vi.fn(() => ({ net: { allowInternalNetwork: true }, integrations: { llmTimeoutMs: 900_000 } })),
}));
vi.mock('../../../src/app-config', () => ({ readEnv: readEnvMock }));

import { createPinnedDispatcher } from '../../../src/utils/ssrfGuard';

beforeEach(() => {
  AgentMock.mockClear();
  readEnvMock.mockReturnValue({ net: { allowInternalNetwork: true }, integrations: { llmTimeoutMs: 900_000 } });
});

const optionsOf = () => AgentMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;

describe('createPinnedDispatcher — response ceiling', () => {
  it('applies the ceiling it is given to both header and body waits', () => {
    createPinnedDispatcher('10.0.0.5', true, 900_000);

    expect(optionsOf().headersTimeout).toBe(900_000);
    expect(optionsOf().bodyTimeout).toBe(900_000);
  });

  it('leaves undici its own default when no ceiling is given', () => {
    // Everything that is not the LLM keeps the shorter wait: a hung weather call
    // should not be held open for a quarter of an hour.
    createPinnedDispatcher('10.0.0.5', true);

    expect(optionsOf().headersTimeout).toBeUndefined();
    expect(optionsOf().bodyTimeout).toBeUndefined();
  });

  it('still pins the connection to the validated IP', () => {
    createPinnedDispatcher('10.0.0.5', true, 900_000);

    const lookup = (optionsOf().connect as { lookup: Function }).lookup;
    const seen: unknown[] = [];
    lookup('evil.example', {}, (...args: unknown[]) => seen.push(...args));
    expect(seen).toContain('10.0.0.5');
  });
});
