import { describe, expect, it, vi } from 'vitest';
import { LlmCapabilitiesController } from '../../../../src/nest/llm-parse/llm-capabilities.controller';
import type { User } from '../../../../src/types';

const user = { id: 7 } as User;

function make(overrides: { configured?: boolean; photos?: boolean } = {}) {
  const llmParse = {
    isAvailable: vi.fn(() => overrides.configured ?? true),
    readsPhotos: vi.fn(() => overrides.photos ?? true),
  };
  return { ctrl: new LlmCapabilitiesController(llmParse as never), llmParse };
}

describe('LlmCapabilitiesController', () => {
  it('answers for the caller, not for the instance', () => {
    const { ctrl, llmParse } = make();

    expect(ctrl.capabilities(user)).toEqual({ configured: true, photos: true });
    expect(llmParse.isAvailable).toHaveBeenCalledWith(7);
    expect(llmParse.readsPhotos).toHaveBeenCalledWith(7);
  });

  it('separates "a model is set" from "that model can see"', () => {
    // The text-only case: booking imports and PDF invoices still work, so the
    // scanner stays — it is the camera that has nothing to offer.
    const { ctrl } = make({ configured: true, photos: false });
    expect(ctrl.capabilities(user)).toEqual({ configured: true, photos: false });
  });

  it('says no to both when nothing is configured', () => {
    const { ctrl } = make({ configured: false, photos: false });
    expect(ctrl.capabilities(user)).toEqual({ configured: false, photos: false });
  });
});
