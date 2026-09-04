import { describe, it, expect, vi, beforeEach } from 'vitest';

// LlmConfigResolver is constructor-injected — a stub instance instead of the
// old path mock (same behaviors as before the DI move).
const resolveLlmConfig = vi.fn();

const { createLlmClient, extract } = vi.hoisted(() => {
  const extract = vi.fn();
  return { createLlmClient: vi.fn(() => ({ extract })), extract };
});
vi.mock('../../../../src/nest/llm-parse/llm-client.factory', () => ({ createLlmClient }));

const { extractText } = vi.hoisted(() => ({ extractText: vi.fn(async () => 'Flight AB123') }));
vi.mock('../../../../src/nest/llm-parse/text-extract', async (orig) => {
  const actual = await orig() as Record<string, unknown>;
  return { ...actual, extractText };
});

const { routeExtraction, detectFlightNumbers } = vi.hoisted(() => ({
  routeExtraction: vi.fn(),
  detectFlightNumbers: vi.fn(() => [] as string[]),
}));
vi.mock('../../../../src/nest/llm-parse/router/extraction-router', () => ({ routeExtraction, detectFlightNumbers }));

// The native Ollama transport. A local receipt read goes here rather than to the
// OpenAI-compatible client — measured, that path returns nothing at all.
const extractEnforced = vi.hoisted(() => vi.fn(async () => ({ receipts: [] })));
vi.mock('../../../../src/nest/llm-parse/router/ollama-format.client', () => ({ extractEnforced }));

import { LlmParseService } from '../../../../src/nest/llm-parse/llm-parse.service';
import type { LlmConfigResolver } from '../../../../src/nest/llm-parse/llm-config.resolver';
import type { LlmLocalService } from '../../../../src/nest/llm-parse/llm-local.service';
import type { RuntimeEnvService } from '../../../../src/nest/app-config/runtime-env.service';

const cfg = (over: Record<string, unknown> = {}) => ({ provider: 'openai', model: 'm', multimodal: false, ...over });
const llmConfigStub = { resolve: resolveLlmConfig } as unknown as LlmConfigResolver;
/** Ollama's own answer about a model. `null` = an older server with nothing to say. */
const localCapabilities = vi.fn<(baseUrl: string | undefined, model: string) => Promise<string[] | null>>(
  async () => null,
);
const llmLocalStub = { capabilities: localCapabilities } as unknown as LlmLocalService;

const svc = () =>
  new LlmParseService(llmConfigStub, llmLocalStub, { isManaged: () => false } as unknown as RuntimeEnvService);
const file = (name: string, body = 'Flight AB123') => ({ buffer: Buffer.from(body), originalName: name });

beforeEach(() => {
  vi.clearAllMocks();
  resolveLlmConfig.mockReturnValue(cfg());
  extract.mockResolvedValue([{ '@type': 'FlightReservation' }]);
  extractText.mockResolvedValue('Flight AB123');
  detectFlightNumbers.mockReturnValue([]);
  routeExtraction.mockResolvedValue({ kiItems: [{ '@type': 'LodgingReservation' }], warnings: [] });
});

describe('LlmParseService', () => {
  it('isAvailable reflects whether a config resolves', () => {
    resolveLlmConfig.mockReturnValueOnce(null);
    expect(svc().isAvailable(1)).toBe(false);
    expect(svc().isAvailable(1)).toBe(true);
  });

  it('returns a not-configured warning when no config resolves', async () => {
    resolveLlmConfig.mockReturnValue(null);
    const res = await svc().parse(file('a.txt'), 1);
    expect(res.kiItems).toEqual([]);
    expect(res.warnings[0]).toMatch(/not configured/i);
    expect(extract).not.toHaveBeenCalled();
  });

  it('sends extracted text for a text-like file', async () => {
    const res = await svc().parse(file('a.txt'), 1);
    expect(res.kiItems).toEqual([{ '@type': 'FlightReservation' }]);
    const input = extract.mock.calls[0][0];
    expect(input.text).toBe('Flight AB123');
    expect(input.file).toBeUndefined();
  });

  it('extracts text for a pdf on the OpenAI-compatible/local path (no native bytes)', async () => {
    extractText.mockResolvedValue('Hotel X');
    await svc().parse(file('a.pdf', '%PDF'), 1);
    const input = extract.mock.calls[0][0];
    expect(input.text).toBe('Hotel X');
    expect(input.file).toBeUndefined();
  });

  it('sends a pdf as native bytes only for Anthropic', async () => {
    resolveLlmConfig.mockReturnValue(cfg({ provider: 'anthropic' }));
    await svc().parse(file('a.pdf', '%PDF'), 1);
    const input = extract.mock.calls[0][0];
    expect(input.file).toEqual({ mimeType: 'application/pdf', data: expect.any(Buffer) });
    expect(input.text).toBeUndefined();
    expect(extractText).not.toHaveBeenCalled();
  });

  it('warns when a pdf yields no readable text (e.g. a scan)', async () => {
    extractText.mockResolvedValue('   ');
    const res = await svc().parse(file('a.pdf', '%PDF'), 1);
    expect(res.kiItems).toEqual([]);
    expect(res.warnings[0]).toMatch(/no readable text/i);
    expect(extract).not.toHaveBeenCalled();
  });

  it('folds flattened type fields into reservationFor (small-model output)', async () => {
    extract.mockResolvedValue([{
      '@type': 'FlightReservation',
      reservationNumber: 'ABC',
      flightNumber: 'EZY1357',
      airline: { iataCode: 'EG' },
      departureAirport: { iataCode: 'GEG' },
      arrivalAirport: { iataCode: 'AMS' },
      departureTime: '2026-06-11T10:00:00',
    }]);
    const res = await svc().parse(file('a.txt'), 1);
    const item = res.kiItems[0] as any;
    expect(item.reservationNumber).toBe('ABC');
    expect(item.reservationFor).toMatchObject({ flightNumber: 'EZY1357', departureAirport: { iataCode: 'GEG' } });
    // root-level keys are not duplicated into reservationFor
    expect(item.reservationFor.reservationNumber).toBeUndefined();
  });

  it('leaves already-nested reservationFor untouched', async () => {
    extract.mockResolvedValue([{ '@type': 'FlightReservation', reservationFor: { flightNumber: 'X1' } }]);
    const res = await svc().parse(file('a.txt'), 1);
    expect((res.kiItems[0] as any).reservationFor).toEqual({ flightNumber: 'X1' });
  });

  it('drops nodes without a string @type and warns', async () => {
    extract.mockResolvedValue([{ '@type': 'FlightReservation' }, { foo: 'bar' }]);
    const res = await svc().parse(file('a.txt'), 1);
    expect(res.kiItems).toEqual([{ '@type': 'FlightReservation' }]);
    expect(res.warnings.some(w => /unrecognized/i.test(w))).toBe(true);
  });

  it('degrades to a warning when the client throws', async () => {
    extract.mockRejectedValue(new Error('boom'));
    const res = await svc().parse(file('a.txt'), 1);
    expect(res.kiItems).toEqual([]);
    expect(res.warnings[0]).toMatch(/AI parsing failed/i);
  });

  it('logs the swallowed client error to console.error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    extract.mockRejectedValue(new Error('boom'));
    await svc().parse(file('a.txt'), 1);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[llm-parse]'), 'boom');
    spy.mockRestore();
  });

  it('routes the local provider through the extraction router instead of the single-shot client', async () => {
    resolveLlmConfig.mockReturnValue(cfg({ provider: 'local', baseUrl: 'http://ollama:11434/v1', apiKey: 'k' }));
    extractText.mockResolvedValue('Hotel booking');
    routeExtraction.mockResolvedValue({ kiItems: [{ '@type': 'LodgingReservation' }], warnings: ['note'] });
    const res = await svc().parse(file('a.txt'), 1);
    expect(res.kiItems).toEqual([{ '@type': 'LodgingReservation' }]);
    expect(res.warnings).toEqual(['note']);
    expect(extract).not.toHaveBeenCalled();
    expect(routeExtraction).toHaveBeenCalledWith('Hotel booking', { baseUrl: 'http://ollama:11434/v1', model: 'm', apiKey: 'k' });
  });

  it('keeps the wide text cap (16k) for a local flight itinerary but tightens it (6k) otherwise', async () => {
    const long = 'x'.repeat(7000);
    extractText.mockResolvedValue(long);

    resolveLlmConfig.mockReturnValue(cfg({ provider: 'local' }));
    detectFlightNumbers.mockReturnValue(['AB123']);
    await svc().parse(file('flights.txt'), 1);
    expect(routeExtraction.mock.calls[0][0]).toHaveLength(7000); // under the 16k cap, untouched

    vi.clearAllMocks();
    resolveLlmConfig.mockReturnValue(cfg({ provider: 'local' }));
    extractText.mockResolvedValue(long);
    detectFlightNumbers.mockReturnValue([]);
    routeExtraction.mockResolvedValue({ kiItems: [], warnings: [] });
    await svc().parse(file('hotel.txt'), 1);
    expect(routeExtraction.mock.calls[0][0]).toHaveLength(6000); // single booking → tighter cap
  });

  it('degrades to a warning when the local router throws', async () => {
    resolveLlmConfig.mockReturnValue(cfg({ provider: 'local' }));
    routeExtraction.mockRejectedValue(new Error('ollama down'));
    const res = await svc().parse(file('a.txt'), 1);
    expect(res.kiItems).toEqual([]);
    expect(res.warnings[0]).toMatch(/AI parsing failed/i);
  });

  it('logs the swallowed router error to console.error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    resolveLlmConfig.mockReturnValue(cfg({ provider: 'local' }));
    routeExtraction.mockRejectedValue(new Error('ollama down'));
    await svc().parse(file('a.txt'), 1);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[llm-parse]'), 'ollama down');
    spy.mockRestore();
  });

  it('warns when the file cannot be read (text extraction throws)', async () => {
    extractText.mockRejectedValue(new Error('corrupt pdf'));
    const res = await svc().parse(file('a.pdf', '%PDF'), 1);
    expect(res.kiItems).toEqual([]);
    expect(res.warnings[0]).toMatch(/could not read file/i);
    expect(res.warnings[0]).toContain('corrupt pdf');
  });

  it('tells the client the endpoint is a self-hosted one, which is what a local body may ask for', async () => {
    resolveLlmConfig.mockReturnValue(cfg({ provider: 'openai' }));
    await svc().parse(file('a.txt'), 1);
    expect(extract.mock.calls[0][0].local).toBe(false);
  });
});

describe('LlmParseService.parseReceipt', () => {
  it('returns a not-configured warning when no config resolves', async () => {
    resolveLlmConfig.mockReturnValue(null);
    const res = await svc().parseReceipt(file('receipt.jpg'), 1);
    expect(res.receipts).toEqual([]);
    expect(res.warnings[0]).toMatch(/not configured/i);
    expect(extract).not.toHaveBeenCalled();
  });

  it('sends a photo as native image bytes on any provider', async () => {
    extract.mockResolvedValue([{ doc_type: 'meal', total: 12 }]);
    const res = await svc().parseReceipt(file('IMG_1.jpeg', 'binary'), 1);
    const input = extract.mock.calls[0][0];
    expect(input.file).toEqual({ mimeType: 'image/jpeg', data: Buffer.from('binary') });
    expect(input.text).toBeUndefined();
    expect(input.rootKey).toBe('receipts');
    expect(res.receipts).toEqual([{ doc_type: 'meal', total: 12 }]);
  });

  it('extracts text for a pdf invoice on the OpenAI-compatible path', async () => {
    extractText.mockResolvedValue('TOTAL 42,00 EUR');
    await svc().parseReceipt(file('invoice.pdf', '%PDF'), 1);
    const input = extract.mock.calls[0][0];
    expect(input.text).toBe('TOTAL 42,00 EUR');
    expect(input.file).toBeUndefined();
  });

  it('sends a pdf invoice as native bytes for Anthropic', async () => {
    resolveLlmConfig.mockReturnValue(cfg({ provider: 'anthropic' }));
    await svc().parseReceipt(file('invoice.pdf', '%PDF'), 1);
    const input = extract.mock.calls[0][0];
    expect(input.file?.mimeType).toBe('application/pdf');
  });

  it('tells the user to photograph a PDF that has no text layer', async () => {
    extractText.mockResolvedValue('   ');
    const res = await svc().parseReceipt(file('scan.pdf', '%PDF'), 1);
    expect(res.receipts).toEqual([]);
    expect(res.warnings[0]).toMatch(/no readable text/i);
    expect(extract).not.toHaveBeenCalled();
  });

  it('says the model cannot read images rather than quoting the provider 400', async () => {
    // What a text-only model answers when a photo is sent to it. The raw body is
    // nested, escaped JSON that names no fix — and this never succeeds on retry,
    // so the message has to point at the setting that changes it.
    extract.mockRejectedValue(
      new Error(
        'LLM request failed (400): {"error":{"message":"{\\"error\\":{\\"code\\":400,\\"message\\":\\"Multimodal data provided, but model does not support multimodal requests.\\"}}"}}'
      )
    );

    const res = await svc().parseReceipt(file('receipt.jpg', 'binary'), 1);

    expect(res.warnings[0]).toMatch(/cannot read images/i);
    expect(res.warnings[0]).toMatch(/vision-capable/i);
    expect(res.warnings[0]).not.toMatch(/invalid_request_error/);
  });

  it('routes every provider failure through the translator, never the raw body', async () => {
    // The service must not pass a rejection straight to the panel: a 503 is a
    // model that never answered, and that is what the user is told. The full
    // mapping lives in llm-failure.test.ts; this pins that the service uses it.
    extract.mockRejectedValue(new Error('LLM request failed (503): upstream unavailable'));

    const res = await svc().parseReceipt(file('receipt.jpg', 'binary'), 1);

    expect(res.warnings[0]).toMatch(/did not answer in time/i);
    expect(res.warnings[0]).not.toMatch(/upstream unavailable/);
  });

  it('degrades to a warning when the provider call fails', async () => {
    extract.mockRejectedValue(new Error('boom'));
    const res = await svc().parseReceipt(file('receipt.png', 'binary'), 1);
    expect(res.receipts).toEqual([]);
    expect(res.warnings[0]).toMatch(/scan failed/i);
  });
});

describe('LlmParseService.readsPhotos', () => {
  beforeEach(() => localCapabilities.mockResolvedValue(null));

  it('takes the operator at their word when the switch is on', async () => {
    resolveLlmConfig.mockReturnValue(cfg({ model: 'some-local-thing', multimodal: true }));
    await expect(svc().readsPhotos(1)).resolves.toBe(true);
  });

  it('asks the local server, which knows, instead of guessing from the id', async () => {
    // Verified against Ollama 0.32.15: qwen3.5:4b reports vision, qwen3:8b does not.
    resolveLlmConfig.mockReturnValue(cfg({ provider: 'local', model: 'anything-at-all' }));
    localCapabilities.mockResolvedValue(['completion', 'vision', 'tools', 'thinking']);
    await expect(svc().readsPhotos(1)).resolves.toBe(true);
    expect(localCapabilities).toHaveBeenCalledWith(undefined, 'anything-at-all');
  });

  it('believes the local server when it says the model is blind, id notwithstanding', async () => {
    resolveLlmConfig.mockReturnValue(cfg({ provider: 'local', model: 'qwen3.5:4b' }));
    localCapabilities.mockResolvedValue(['completion', 'tools']);
    await expect(svc().readsPhotos(1)).resolves.toBe(false);
  });

  it('falls back to the id when the server is too old to answer', async () => {
    // A model that works must not be hidden because Ollama predates the field.
    resolveLlmConfig.mockReturnValue(cfg({ provider: 'local', model: 'qwen3.5:4b' }));
    localCapabilities.mockResolvedValue(null);
    await expect(svc().readsPhotos(1)).resolves.toBe(true);
  });

  it('never asks the local server about a cloud model', async () => {
    resolveLlmConfig.mockReturnValue(cfg({ provider: 'openai', model: 'gpt-4o' }));
    await expect(svc().readsPhotos(1)).resolves.toBe(true);
    expect(localCapabilities).not.toHaveBeenCalled();
  });

  it('says no to a catalogue model that is text-only, switch off', async () => {
    // Not a lesser choice for a photograph — the wrong one: the provider rejects
    // the image rather than doing its best with it.
    resolveLlmConfig.mockReturnValue(cfg({ model: 'qwen3:8b', multimodal: false }));
    await expect(svc().readsPhotos(1)).resolves.toBe(false);
  });

  it('says no when nothing is configured at all', async () => {
    resolveLlmConfig.mockReturnValue(null);
    await expect(svc().readsPhotos(1)).resolves.toBe(false);
  });
});

describe('LlmParseService.parseReceipt — on a self-hosted server', () => {
  beforeEach(() => extractEnforced.mockResolvedValue({ receipts: [] }));

  it('reads through the native transport, with reasoning off, not the /v1 client', async () => {
    // Measured on qwen3.5:4b, same prompt, same server: /v1 spent 485s and
    // answered with nothing (the whole token budget went on reasoning, which
    // `think` cannot switch off there); /api/chat answered in 49s.
    resolveLlmConfig.mockReturnValue(cfg({ provider: 'local', baseUrl: 'http://ollama.lan:11434/v1' }));
    extractEnforced.mockResolvedValue({ receipts: [{ doc_type: 'meal', total: 9.13 }] });

    const res = await svc().parseReceipt(file('receipt.jpg', 'binary'), 1);

    expect(extract).not.toHaveBeenCalled();
    const sent = extractEnforced.mock.calls[0][0];
    expect(sent.baseUrl).toBe('http://ollama.lan:11434/v1');
    expect(sent.images).toHaveLength(1);
    // No grammar: a constrained read answered with fewer fields than the mapper needs.
    expect(sent.schema).toBeUndefined();
    expect(res.receipts).toEqual([{ doc_type: 'meal', total: 9.13 }]);
  });

  it('gives a photograph the wider context window it costs, and text the narrow one', async () => {
    resolveLlmConfig.mockReturnValue(cfg({ provider: 'local' }));

    await svc().parseReceipt(file('receipt.jpg', 'binary'), 1);
    expect(extractEnforced.mock.calls[0][0].numCtx).toBe(16384);

    extractText.mockResolvedValue('TOTAL 9,13 EUR');
    await svc().parseReceipt(file('invoice.txt'), 1);
    const textCall = extractEnforced.mock.calls[1][0];
    expect(textCall.numCtx).toBe(8192);
    expect(textCall.images).toBeUndefined();
    expect(textCall.user).toContain('TOTAL 9,13 EUR');
  });

  it('leaves a cloud provider on the OpenAI-compatible client, which has neither problem', async () => {
    resolveLlmConfig.mockReturnValue(cfg({ provider: 'openai' }));
    extract.mockResolvedValue([{ doc_type: 'meal', total: 1 }]);

    await svc().parseReceipt(file('receipt.jpg', 'binary'), 1);

    expect(extractEnforced).not.toHaveBeenCalled();
    expect(extract).toHaveBeenCalled();
  });

  it('reports a native-transport failure with the same vocabulary as any other', async () => {
    resolveLlmConfig.mockReturnValue(cfg({ provider: 'local' }));
    extractEnforced.mockRejectedValueOnce(new Error('Ollama /api/chat failed (500): out of memory'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await svc().parseReceipt(file('receipt.jpg', 'binary'), 1);

    expect(res.receipts).toEqual([]);
    expect(res.failureCode).toBeDefined();
    expect(res.warnings[0]).toMatch(/scan failed/i);
    spy.mockRestore();
  });
});
