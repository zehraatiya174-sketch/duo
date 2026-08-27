import { z } from 'zod';

export const MESSAGE_MAX_LENGTH = 8000;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

export const messageTypeSchema = z.enum([
  'TEXT',
  'IMAGE',
  'VIDEO',
  'AUDIO',
  'VOICE_NOTE',
  'DOCUMENT',
  'CODE',
  'GIF',
  'STICKER',
  'LOCATION',
  'LINK',
  'SYSTEM',
  'CALL',
]);

export const ephemeralModeSchema = z.enum([
  'NORMAL',
  'VIEW_ONCE',
  'VIEW_TWICE',
  'CUSTOM_VIEWS',
  'UNLIMITED_TIMED',
]);

/** The expiry presets offered in the composer, in seconds. */
export const EXPIRY_PRESETS = {
  '30s': 30,
  '1m': 60,
  '5m': 300,
  '1h': 3600,
  '24h': 86_400,
  '7d': 604_800,
} as const;

export type ExpiryPreset = keyof typeof EXPIRY_PRESETS;

export const ephemeralOptionsSchema = z
  .object({
    mode: ephemeralModeSchema.default('NORMAL'),
    /** 1–99, or null for unlimited. Ignored unless mode is CUSTOM_VIEWS. */
    maxViews: z.number().int().min(1).max(99).nullable().optional(),
    /** Absolute expiry measured from send time. */
    expiresInSeconds: z.number().int().min(5).max(2_592_000).nullable().optional(),
    /** Countdown that starts on first open instead of on send. */
    destructAfterSeconds: z.number().int().min(1).max(86_400).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.mode === 'CUSTOM_VIEWS' &&
      (value.maxViews === null || value.maxViews === undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxViews'],
        message: 'CUSTOM_VIEWS requires an explicit view count',
      });
    }
    if (
      value.mode === 'UNLIMITED_TIMED' &&
      !value.expiresInSeconds &&
      !value.destructAfterSeconds
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresInSeconds'],
        message: 'UNLIMITED_TIMED requires an expiry or a self-destruct timer',
      });
    }
  });

export type EphemeralOptions = z.infer<typeof ephemeralOptionsSchema>;

/** Resolves a mode into the concrete view allowance the server enforces. */
export function resolveMaxViews(options: EphemeralOptions): number | null {
  switch (options.mode) {
    case 'VIEW_ONCE':
      return 1;
    case 'VIEW_TWICE':
      return 2;
    case 'CUSTOM_VIEWS':
      return options.maxViews ?? 1;
    case 'UNLIMITED_TIMED':
    case 'NORMAL':
      return null;
  }
}

const cuidLike = z.string().min(1).max(64);

export const sendMessageSchema = z
  .object({
    clientId: z.string().min(8).max(64),
    chatId: cuidLike,
    type: messageTypeSchema.default('TEXT'),
    body: z.string().max(MESSAGE_MAX_LENGTH).optional(),
    codeLanguage: z
      .string()
      .max(24)
      .regex(/^[a-z0-9+#._-]*$/i)
      .optional(),
    replyToId: cuidLike.optional(),
    forwardedFromId: cuidLike.optional(),
    attachmentIds: z.array(cuidLike).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
    location: z
      .object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        label: z.string().max(200).optional(),
      })
      .optional(),
    ephemeral: ephemeralOptionsSchema.optional(),
    mentions: z
      .array(
        z.object({
          userId: cuidLike,
          offset: z.number().int().min(0),
          length: z.number().int().min(1).max(64),
        }),
      )
      .max(16)
      .optional(),
  })
  .superRefine((value, ctx) => {
    const hasBody = Boolean(value.body && value.body.trim().length > 0);
    const hasAttachments = Boolean(value.attachmentIds && value.attachmentIds.length > 0);
    const hasLocation = Boolean(value.location);
    if (!hasBody && !hasAttachments && !hasLocation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['body'],
        message: 'A message needs text, an attachment, or a location',
      });
    }
    if (value.type === 'LOCATION' && !hasLocation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['location'],
        message: 'Location messages require coordinates',
      });
    }
  });

export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const editMessageSchema = z.object({
  messageId: cuidLike,
  body: z.string().trim().min(1, 'Message cannot be empty').max(MESSAGE_MAX_LENGTH),
});
export type EditMessageInput = z.infer<typeof editMessageSchema>;

export const deleteMessageSchema = z.object({
  messageId: cuidLike,
  scope: z.enum(['me', 'everyone']),
});
export type DeleteMessageInput = z.infer<typeof deleteMessageSchema>;

/**
 * Rejects anything that is not a plausible emoji. Prevents the reaction row
 * from being used as an arbitrary text store.
 */
export const reactionSchema = z.object({
  messageId: cuidLike,
  emoji: z
    .string()
    .min(1)
    .max(16)
    .refine(
      (value) => /\p{Extended_Pictographic}/u.test(value) && !/[\p{L}\p{N}]/u.test(value),
      'Reactions must be an emoji',
    ),
});
export type ReactionInput = z.infer<typeof reactionSchema>;

export const listMessagesSchema = z.object({
  chatId: cuidLike,
  /** ISO timestamp + id, base64url encoded. Returns messages strictly older. */
  cursor: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
  /** Loads the page *containing* this message, for jump-to-message. */
  around: cuidLike.optional(),
});
export type ListMessagesInput = z.infer<typeof listMessagesSchema>;

export const searchMessagesSchema = z.object({
  chatId: cuidLike,
  query: z.string().trim().max(200).default(''),
  type: messageTypeSchema.optional(),
  kind: z
    .enum([
      'IMAGE',
      'VIDEO',
      'AUDIO',
      'VOICE_NOTE',
      'DOCUMENT',
      'ARCHIVE',
      'GIF',
      'STICKER',
      'OTHER',
    ])
    .optional(),
  authorId: cuidLike.optional(),
  hasLink: z.coerce.boolean().optional(),
  hasAttachment: z.coerce.boolean().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
export type SearchMessagesInput = z.infer<typeof searchMessagesSchema>;

export const receiptSchema = z.object({
  chatId: cuidLike,
  messageIds: z.array(cuidLike).min(1).max(200),
});
export type ReceiptInput = z.infer<typeof receiptSchema>;

export const forwardMessageSchema = z.object({
  messageIds: z.array(cuidLike).min(1).max(20),
  chatId: cuidLike,
});
export type ForwardMessageInput = z.infer<typeof forwardMessageSchema>;
