import { AI_PROVIDER_CONFIGS, applyAiProviderDefaults, loadAiSettings, type AiProvider } from '@/models/ai'
import { err, normalizeError, ok, type AppResult } from '@/models/result'
import { loadAiApiKey } from './AiSecretService'
import { runAiMarkdownCompletion } from './AiMarkdownService'
import type { GeneratedViewExecutor } from './ViewService'

export class GeneratedViewAiExecutor implements GeneratedViewExecutor {
  async generate(input: { prompt: string; provider: string; model: string; sources: unknown }): Promise<AppResult<unknown>> {
    if (!AI_PROVIDER_CONFIGS.some((item) => item.value === input.provider)) {
      return err({ code: 'validation-error', message: `不支持的 Generated View Provider：${input.provider}` })
    }
    try {
      let settings = applyAiProviderDefaults(loadAiSettings(), input.provider as AiProvider)
      settings = { ...settings, model: input.model, apiKey: await loadAiApiKey(input.provider as AiProvider) }
      let content = ''
      await runAiMarkdownCompletion({
        prompt: input.prompt,
        context: JSON.stringify(input.sources, null, 2),
        settings,
        systemPrompt: '你正在生成只读知识视图。只能根据提供的版本化来源生成内容，不得声称已修改规范知识。',
        onDelta: (delta, channel) => { if (channel !== 'reasoning') content += delta },
      })
      return ok({ format: 'markdown', content })
    } catch (error) {
      return err(normalizeError(error, 'Generated View 生成失败。'))
    }
  }
}
