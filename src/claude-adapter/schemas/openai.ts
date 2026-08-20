import { z } from 'zod';

const ChatMessageSchema = z.object({
  role: z.string(),
  content: z.unknown().optional(),
}).passthrough();

export const OpenAIChatCompletionsRequestSchema = z.object({
  model: z.string(),
  messages: z.array(ChatMessageSchema),
  stream: z.boolean().optional(),
}).passthrough();

export type OpenAIChatCompletionsRequest = z.infer<typeof OpenAIChatCompletionsRequestSchema>;
