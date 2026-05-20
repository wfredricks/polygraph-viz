/**
 * Bedrock client for polygraph-viz NL features.
 *
 * Two operations:
 *   - embed(text): Titan-v2 text embedding, returns Float32Array.
 *   - chat(systemPrompt, messages, options): Claude messages API call,
 *     returns either a single string (non-streaming) or an async
 *     iterable of token chunks (streaming).
 *
 * Auth: uses standard AWS SDK credential resolution (env vars, shared
 * credentials file, IAM role). When `awsProfile` is set, the AWS_PROFILE
 * environment variable is honored.
 *
 * Why this module exists: keeps the rest of the codebase free of
 * AWS-SDK noise. server.ts treats embed() and chat() as opaque.
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';

export interface BedrockClientOptions {
  awsProfile?: string;
  awsRegion?: string;
  llmModel?: string;
  embedModel?: string;
}

// Why us.* prefix: Claude 4.5 Haiku requires an inference profile for
// on-demand calls; the bare model id only works with provisioned
// throughput. `us.*` is the US-region cross-AZ profile and the cheapest
// way to get on-demand access.
const DEFAULT_LLM_MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const DEFAULT_EMBED_MODEL = 'amazon.titan-embed-text-v2:0';
const DEFAULT_REGION = 'us-east-1';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  /**
   * When set, returns an async iterable of token chunks rather than a
   * single string. Used by /api/chat to stream Server-Sent Events.
   */
  stream?: boolean;
}

/**
 * Wrapper around the Bedrock Runtime SDK that knows two patterns:
 * Titan text-embeddings and Claude messages.
 */
export class BedrockClient {
  private client: BedrockRuntimeClient;
  private llmModel: string;
  private embedModel: string;

  constructor(opts: BedrockClientOptions = {}) {
    // Why: AWS SDK reads AWS_PROFILE from process.env. We mutate the env
    // before constructing the client when an explicit profile is given,
    // which is the documented way to switch profiles per-process.
    if (opts.awsProfile) {
      process.env['AWS_PROFILE'] = opts.awsProfile;
    }
    this.client = new BedrockRuntimeClient({
      region: opts.awsRegion ?? DEFAULT_REGION,
    });
    this.llmModel = opts.llmModel ?? DEFAULT_LLM_MODEL;
    this.embedModel = opts.embedModel ?? DEFAULT_EMBED_MODEL;
  }

  /**
   * Returns the configured model ids so callers can surface them in
   * logs and audit records.
   */
  describe(): { llmModel: string; embedModel: string } {
    return { llmModel: this.llmModel, embedModel: this.embedModel };
  }

  /**
   * Compute a Titan text embedding. Output is a 1024-dimensional
   * Float32Array (matches v2:0).
   */
  async embed(text: string): Promise<Float32Array> {
    const payload = JSON.stringify({
      inputText: text,
      dimensions: 1024,
      normalize: true,
    });
    const cmd = new InvokeModelCommand({
      modelId: this.embedModel,
      contentType: 'application/json',
      accept: 'application/json',
      body: new TextEncoder().encode(payload),
    });
    const r = await this.client.send(cmd);
    const decoded = new TextDecoder().decode(r.body);
    const parsed = JSON.parse(decoded) as { embedding: number[] };
    return Float32Array.from(parsed.embedding);
  }

  /**
   * Non-streaming chat completion. Returns the assistant text.
   */
  async chat(
    systemPrompt: string,
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): Promise<string> {
    const body = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: options.maxTokens ?? 1024,
      temperature: options.temperature ?? 0.3,
      system: systemPrompt,
      messages: messages.map((m) => ({
        role: m.role,
        content: [{ type: 'text', text: m.content }],
      })),
    };
    const cmd = new InvokeModelCommand({
      modelId: this.llmModel,
      contentType: 'application/json',
      accept: 'application/json',
      body: new TextEncoder().encode(JSON.stringify(body)),
    });
    const r = await this.client.send(cmd);
    const decoded = new TextDecoder().decode(r.body);
    const parsed = JSON.parse(decoded) as {
      content: Array<{ type: string; text?: string }>;
    };
    return parsed.content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
  }

  /**
   * Streaming chat. Yields text chunks as they arrive from Bedrock.
   * Caller is responsible for translating chunks into SSE frames.
   */
  async *chatStream(
    systemPrompt: string,
    messages: ChatMessage[],
    options: Omit<ChatOptions, 'stream'> = {},
  ): AsyncIterable<string> {
    const body = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: options.maxTokens ?? 1024,
      temperature: options.temperature ?? 0.3,
      system: systemPrompt,
      messages: messages.map((m) => ({
        role: m.role,
        content: [{ type: 'text', text: m.content }],
      })),
    };
    const cmd = new InvokeModelWithResponseStreamCommand({
      modelId: this.llmModel,
      contentType: 'application/json',
      accept: 'application/json',
      body: new TextEncoder().encode(JSON.stringify(body)),
    });
    const r = await this.client.send(cmd);
    if (!r.body) return;
    const decoder = new TextDecoder();
    for await (const event of r.body) {
      if (!event.chunk?.bytes) continue;
      const decoded = decoder.decode(event.chunk.bytes);
      try {
        const parsed = JSON.parse(decoded) as {
          type: string;
          delta?: { type?: string; text?: string };
        };
        if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
          yield parsed.delta.text;
        }
      } catch {
        // Why: streaming chunks are line-delimited JSON; rare malformed
        // chunks are tolerated rather than crashing the stream.
      }
    }
  }
}
