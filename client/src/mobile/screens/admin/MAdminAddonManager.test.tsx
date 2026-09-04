// FE-MOB-ADDON-001 to FE-MOB-ADDON-003
import { render, screen, waitFor } from '../../../../tests/helpers/render';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../../../tests/helpers/msw/server';
import { resetAllStores, seedStore } from '../../../../tests/helpers/store';
import { useSettingsStore } from '../../../store/settingsStore';
import { useAddonStore } from '../../../store/addonStore';
import { ToastContainer } from '../../../components/shared/Toast';
import MAdminAddonManager from './MAdminAddonManager';

/** The instance-wide AI config, which is the only part of this screen that
 *  carries state of its own — the rest mirrors the desktop AddonManager. */
function llmAddon(config: Record<string, unknown> = {}) {
  return {
    id: 'llm_parsing',
    name: 'AI Parsing',
    description: 'Extract bookings from files',
    icon: 'Sparkles',
    type: 'integration',
    enabled: true,
    config,
  };
}

function addonsRoute(config: Record<string, unknown>) {
  return http.get('/api/admin/addons', () => HttpResponse.json({ addons: [llmAddon(config)] }));
}

function modelsRoute(names: string[]) {
  return http.get('/api/admin/llm/local/models', () =>
    HttpResponse.json({ models: names.map(name => ({ name, size: 1 })) }),
  );
}

function visionSwitch(): HTMLElement {
  return screen.getByRole('switch', { name: 'This model reads images' });
}

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

beforeEach(() => {
  resetAllStores();
  seedStore(useSettingsStore, { settings: { dark_mode: false } });
  vi.spyOn(useAddonStore.getState(), 'loadAddons').mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MAdminAddonManager', () => {
  it('FE-MOB-ADDON-001: the image switch is settable instance-wide and rides along to the server', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    server.use(
      addonsRoute({ provider: 'local', model: 'qwen3:8b', baseUrl: '', apiKey: '', multimodal: false }),
      modelsRoute(['qwen3:8b']),
      http.put('/api/admin/addons/llm_parsing', async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ success: true });
      }),
    );
    render(<><ToastContainer /><MAdminAddonManager /></>);

    await waitFor(() => expect(visionSwitch()).toHaveAttribute('aria-checked', 'false'));

    await user.click(visionSwitch());
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByText('Saved');
    expect(bodies[0]).toEqual({
      config: { provider: 'local', model: 'qwen3:8b', baseUrl: '', apiKey: '', multimodal: true },
    });
  });

  it('FE-MOB-ADDON-002: a vision model in the catalogue arrives with the switch already on', async () => {
    server.use(
      addonsRoute({ provider: 'local', model: 'qwen3.5:4b', baseUrl: '', apiKey: '' }),
      modelsRoute(['qwen3.5:4b']),
    );
    render(<MAdminAddonManager />);

    // No stored flag: an instance configured before this switch existed must not
    // be told its vision model is blind.
    await waitFor(() => expect(visionSwitch()).toHaveAttribute('aria-checked', 'true'));
    expect(screen.queryByText(/is not known to read images/)).not.toBeInTheDocument();
  });

  it('FE-MOB-ADDON-003: claiming an unknown model reads images warns where the failure will come from', async () => {
    const user = userEvent.setup();
    server.use(
      addonsRoute({ provider: 'local', model: 'mistral:7b', baseUrl: '', apiKey: '' }),
      modelsRoute(['mistral:7b']),
    );
    render(<MAdminAddonManager />);

    await waitFor(() => expect(visionSwitch()).toHaveAttribute('aria-checked', 'false'));

    await user.click(visionSwitch());

    // Not blocked — the catalogue cannot know every model, so this is a warning.
    await screen.findByText(/mistral:7b is not known to read images/);
    expect(visionSwitch()).toHaveAttribute('aria-checked', 'true');
  });
});
