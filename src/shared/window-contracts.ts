import { z } from 'zod'
import { DEFAULT_ACCENT_COLOR } from './appearance'

export const windowThemePreferenceSchema = z.enum(['light', 'dark', 'system'])
export const accentColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .transform((value) => value.toUpperCase())
export const windowCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('minimize') }).strict(),
  z.object({ action: z.literal('toggleMaximize') }).strict(),
  z.object({ action: z.literal('close') }).strict(),
  z.object({ action: z.literal('theme'), theme: windowThemePreferenceSchema }).strict(),
  z.object({ action: z.literal('accent'), color: accentColorSchema }).strict()
])
export const windowCloseResolutionSchema = z
  .object({ requestId: z.uuid(), allow: z.boolean() })
  .strict()
export const windowPreferencesSchema = z
  .object({
    themePreference: windowThemePreferenceSchema,
    accentColor: accentColorSchema.default(DEFAULT_ACCENT_COLOR)
  })
  .strict()
