import { z } from 'zod';

/**
 * Admin API contract for /api/admin (admin-only).
 *
 * These schemas exist to satisfy the body-contract ratchet without changing
 * behavior, so they are deliberately permissive: wherever AdminService already
 * emits a bespoke 400 of its own ('Invalid role', 'Name is required',
 * 'Username, email and password are required'), the field stays optional and
 * loosely typed so that error survives byte-identically. Every object schema is
 * non-strict — several clients and tests send extra keys and expect success.
 */

export const adminUserCreateRequestSchema = z.object({
  username: z.string().optional(),
  email: z.string().optional(),
  password: z.string().optional(),
  // Deliberately z.string(), not z.enum: the service's own 'Invalid role' 400
  // is the pinned contract for a bad role.
  role: z.string().optional(),
});
export type AdminUserCreateRequest = z.infer<typeof adminUserCreateRequestSchema>;

export const adminUserUpdateRequestSchema = z.object({
  username: z.string().optional(),
  email: z.string().optional(),
  password: z.string().optional(),
  role: z.string().optional(),
});
export type AdminUserUpdateRequest = z.infer<typeof adminUserUpdateRequestSchema>;

// Values stay z.unknown(): PermissionsService.savePermissions reports unknown
// levels through its `skipped` list (a 200 response field the admin UI shows),
// so narrowing to z.string() would turn that into a 400.
export const adminPermissionsRequestSchema = z.object({
  permissions: z.record(z.string(), z.unknown()),
});
export type AdminPermissionsRequest = z.infer<typeof adminPermissionsRequestSchema>;

export const adminInviteCreateRequestSchema = z.object({
  // string | number: the service parses with parseInt(String(x)), and the
  // admin UI sends numbers while older clients sent strings.
  max_uses: z.union([z.number(), z.string()]).optional(),
  expires_in_days: z.union([z.number(), z.string()]).optional(),
  role: z.enum(['user', 'admin']).optional(),
  // Optional trip binding (#1402): a user who registers via the link is
  // auto-added to this trip. Nullable/absent = a plain registration invite.
  trip_id: z.union([z.number(), z.string()]).nullable().optional(),
});
export type AdminInviteCreateRequest = z.infer<typeof adminInviteCreateRequestSchema>;

export const adminFeatureToggleRequestSchema = z.object({
  enabled: z.boolean(),
});
export type AdminFeatureToggleRequest = z.infer<typeof adminFeatureToggleRequestSchema>;

// Shared by all six packing-template create/update routes. `name` is optional so
// the service's 'Name is required' / 'Category name is required' / 'Item name is
// required' 400s stay the contract, and so the update routes keep treating a
// blank name as a no-op.
export const adminTemplateNameRequestSchema = z.object({
  name: z.string().optional(),
});
export type AdminTemplateNameRequest = z.infer<typeof adminTemplateNameRequestSchema>;

export const adminOidcUpdateRequestSchema = z.object({
  issuer: z.string().optional(),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  display_name: z.string().optional(),
  discovery_url: z.string().optional(),
});
export type AdminOidcUpdateRequest = z.infer<typeof adminOidcUpdateRequestSchema>;

// `config` must stay free-form: each addon stores its own keys, and the AI addon
// round-trips an apiKey mask sentinel that a narrower shape would strip.
export const adminAddonUpdateRequestSchema = z.object({
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});
export type AdminAddonUpdateRequest = z.infer<typeof adminAddonUpdateRequestSchema>;

// Fully partial — the client PUTs one computed key at a time.
export const adminCollabFeaturesRequestSchema = z.object({
  chat: z.boolean().optional(),
  notes: z.boolean().optional(),
  polls: z.boolean().optional(),
  whatsnext: z.boolean().optional(),
});
export type AdminCollabFeaturesRequest = z.infer<typeof adminCollabFeaturesRequestSchema>;

// event type -> channel id -> enabled. Anything narrower would silently drop
// plugin-contributed channels, since the client echoes back the whole matrix.
export const adminNotificationPreferencesRequestSchema = z.record(z.string(), z.record(z.string(), z.boolean()));
export type AdminNotificationPreferencesRequest = z.infer<typeof adminNotificationPreferencesRequestSchema>;

// Heterogeneous values, and `null` is meaningful — SettingsService treats it as
// "reset to the built-in default". z.record also rejects arrays and null bodies,
// preserving the route's object-only guard.
export const adminDefaultUserSettingsRequestSchema = z.record(z.string(), z.unknown());
export type AdminDefaultUserSettingsRequest = z.infer<typeof adminDefaultUserSettingsRequestSchema>;

// Dev-only test sender: every field optional (callers POST {}), and `inApp` is a
// boolean OR the in-app action descriptor the dev panel sends.
export const adminTestNotificationRequestSchema = z.object({
  event: z.string().optional(),
  scope: z.string().optional(),
  targetId: z.number().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  inApp: z.union([z.boolean(), z.record(z.string(), z.unknown())]).optional(),
});
export type AdminTestNotificationRequest = z.infer<typeof adminTestNotificationRequestSchema>;

/**
 * The model the local extractor is tuned for, pullable via Ollama. One entry on
 * purpose: a self-hosted instance needs a model, not a menu, and Qwen3.5 4B is
 * the one that does every job — it extracts a booking out of a PDF and reads a
 * scanned page or a photograph, so nobody has to keep two models resident.
 * Reasoning is turned off on the way out (see the llm-parse clients), which is
 * what keeps it inside a CPU latency budget.
 *
 * Any other model can still be typed in or picked from what Ollama already has;
 * this is the one TREK offers to pull.
 *
 * `vision` says whether the model can be handed the document itself rather than
 * text pulled out of it. It lives here rather than beside either admin screen
 * because both of them had their own copy of this list, and the server needs the
 * same answer they do.
 */
export const LLM_MODEL_CATALOGUE: { id: string; label: string; note: string; recommended: boolean; vision: boolean }[] = [
  {
    id: 'qwen3.5:4b',
    label: 'Qwen3.5 — 4B',
    note: 'Recommended · reads images as well as text, so one model covers every document (3.4 GB, 256K context, thinking auto-disabled)',
    recommended: true,
    vision: true,
  },
];

/**
 * Whether a model is known to read images.
 *
 * The catalogue answers for what it lists. For an id typed by hand this assumes
 * the families that advertise vision do, and says nothing about anything else —
 * a guess that hides a working model is worse than one that lets it try, which
 * is why an explicit override exists alongside.
 */
export function modelReadsPhotos(id: string): boolean {
  const known = LLM_MODEL_CATALOGUE.find((m) => m.id === id.trim());
  if (known) return known.vision;
  return /qwen3\.5|-vl\b|vl:|llava|minicpm-v|vision|gpt-4o|gpt-5|claude|gemini/i.test(id);
}
