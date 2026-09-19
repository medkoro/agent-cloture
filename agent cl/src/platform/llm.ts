export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: LlmToolCall[];
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmResponse {
  content: string;
  toolCalls?: LlmToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LlmProvider {
  complete(messages: LlmMessage[], tools?: unknown[]): Promise<LlmResponse>;
}

export class DeterministicLlmProvider implements LlmProvider {
  private planned = false;

  async complete(messages: LlmMessage[], tools: unknown[] = []): Promise<LlmResponse> {
    if (!this.planned && tools.length) {
      this.planned = true;
      return { content: 'Plan déterministe : consulter la politique avant de produire la clôture.', toolCalls: [{ id: 'deterministic-policy', name: 'get_policy', arguments: {} }] };
    }
    return { content: messages.at(-1)?.content ?? '' };
  }
}

export class AzureOpenAiProvider implements LlmProvider {
  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly deployment: string,
    private readonly apiVersion = '2024-10-21',
  ) {}

  async complete(messages: LlmMessage[], tools: unknown[] = []): Promise<LlmResponse> {
    const url = `${this.endpoint.replace(/\/$/, '')}/openai/deployments/${this.deployment}/chat/completions?api-version=${this.apiVersion}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-key': this.apiKey },
      body: JSON.stringify({ messages, tools, tool_choice: tools.length ? 'auto' : undefined, temperature: 0 }),
    });
    if (!response.ok) throw new Error(`Azure OpenAI ${response.status}: ${await response.text()}`);
    const payload = await response.json() as { choices?: [{ message?: { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const message = payload.choices?.[0]?.message;
    return {
      content: message?.content ?? '',
      toolCalls: message?.tool_calls?.map((call) => ({ id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments) as Record<string, unknown> })),
      usage: { inputTokens: payload.usage?.prompt_tokens ?? 0, outputTokens: payload.usage?.completion_tokens ?? 0 },
    };
  }
}

export class OllamaProvider implements LlmProvider {
  constructor(
    private readonly baseUrl = 'http://127.0.0.1:11434',
    private readonly model = 'qwen3:8b',
  ) {}

  async complete(messages: LlmMessage[], tools: unknown[] = []): Promise<LlmResponse> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages, tools, stream: false, think: false, options: { temperature: 0 } }),
    });
    if (!response.ok) throw new Error(`Ollama ${response.status}: ${await response.text()}`);
    const payload = await response.json() as { message?: { content?: string; tool_calls?: { function: { name: string; arguments: Record<string, unknown> | string } }[] }; prompt_eval_count?: number; eval_count?: number };
    return {
      content: payload.message?.content ?? '',
      toolCalls: payload.message?.tool_calls?.map((call, index) => ({
        id: `ollama-call-${index + 1}`,
        name: call.function.name,
        arguments: typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) as Record<string, unknown> : call.function.arguments,
      })),
      usage: { inputTokens: payload.prompt_eval_count ?? 0, outputTokens: payload.eval_count ?? 0 },
    };
  }
}

export function createLlmProvider(): LlmProvider {
  if (process.env.NODE_ENV === 'test') return new DeterministicLlmProvider();
  if (process.env.LLM_PROVIDER === 'ollama') {
    return new OllamaProvider(process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434', process.env.OLLAMA_MODEL ?? 'qwen3:8b');
  }
  if (process.env.LLM_PROVIDER === 'azure-openai' && process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_DEPLOYMENT) {
    return new AzureOpenAiProvider(process.env.AZURE_OPENAI_ENDPOINT, process.env.AZURE_OPENAI_API_KEY, process.env.AZURE_OPENAI_DEPLOYMENT, process.env.AZURE_OPENAI_API_VERSION);
  }
  return new DeterministicLlmProvider();
}
