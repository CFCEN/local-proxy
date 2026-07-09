import { z } from 'zod';

const TextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
}).passthrough();

const ContentBlockSchema = z.union([
  TextBlockSchema,
  z.object({ type: z.string() }).passthrough(),
]);

const MessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.union([z.string(), z.array(ContentBlockSchema)]),
}).passthrough();

const ToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  input_schema: z.record(z.unknown()).optional(),
}).passthrough();

export const AnthropicMessagesRequestSchema = z.object({
  model: z.string(),
  system: z.union([
    z.string(),
    z.array(ContentBlockSchema),
  ]).optional(),
  messages: z.array(MessageSchema),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  stop_sequences: z.array(z.string()).optional(),
  stream: z.boolean().optional().default(false),
  tools: z.array(ToolSchema).optional(),
}).passthrough();

export type AnthropicMessagesRequest = z.infer<typeof AnthropicMessagesRequestSchema>;
