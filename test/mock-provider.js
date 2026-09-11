import { LlmAdapter } from '@deepseek-ai/dsh-llm';

export const inject = ['llm'];
class EchoHistory extends LlmAdapter {
  async listModels(provider) { return [{ provider, id: 'mock', name: 'Import test', inputModalities: ['text'] }]; }
  async resolveModel(provider, model) { return { provider, id: model, name: 'Import test', context: { contextWindow: 128000 }, defaultMaxTokens: 1024, inputModalities: ['text'], systemPromptUpdate: 'in-history' }; }
  async *stream(options) {
    const history = JSON.stringify(options.messages);
    const text = history.includes('hello from the source') && history.includes('hello from the assistant')
      ? 'IMPORT_CONTINUATION_OK: original conversation history is present.'
      : 'IMPORT_HISTORY_MISSING';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export function apply(ctx) { ctx.llm.registerAdapter(['mock'], new EchoHistory()); }
