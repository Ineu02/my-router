import type { ProviderKind } from '@router/shared';
import type { Provider } from './types.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';

/**
 * Provider catalogue.
 *
 * ── Adding a provider ────────────────────────────────────────────────
 * If it speaks the OpenAI wire format (most do), add one entry to
 * BUILTIN_PROVIDERS below — no new code. If it has its own format, write
 * an adapter implementing `Provider` and reference it in `kind`.
 * Nothing in router-core or the API layer changes either way.
 */

export interface ProviderDefinition {
  id: string;
  displayName: string;
  kind: ProviderKind;
  defaultBaseUrl: string;
  /** Env var holding the key. Extra accounts use _2, _3, ... */
  envKey: string;
  /** Optional env var overriding the base URL. */
  envBaseUrl?: string;
  /** Seed models registered on first boot. */
  models: Array<{
    id: string;
    model: string;
    displayName: string;
    capabilities: string[];
    contextLength: number;
    priority: number;
    costTier: 'free' | 'cheap' | 'standard' | 'premium';
  }>;
  extraHeaders?: Record<string, string>;
  priority: number;
}

export const BUILTIN_PROVIDERS: ProviderDefinition[] = [
  {
    id: 'openai',
    displayName: 'OpenAI',
    kind: 'openai-compatible',
    defaultBaseUrl: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    envBaseUrl: 'OPENAI_BASE_URL',
    priority: 80,
    models: [
      {
        id: 'openai-flagship',
        model: 'gpt-4o',
        displayName: 'GPT-4o',
        capabilities: ['chat', 'vision', 'tools'],
        contextLength: 128_000,
        priority: 80,
        costTier: 'premium',
      },
      {
        id: 'openai-mini',
        model: 'gpt-4o-mini',
        displayName: 'GPT-4o mini',
        capabilities: ['chat', 'vision', 'tools'],
        contextLength: 128_000,
        priority: 60,
        costTier: 'cheap',
      },
    ],
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic Claude',
    kind: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    envKey: 'ANTHROPIC_API_KEY',
    envBaseUrl: 'ANTHROPIC_BASE_URL',
    priority: 90,
    models: [
      {
        id: 'claude-sonnet',
        model: 'claude-sonnet-4-20250514',
        displayName: 'Claude Sonnet 4',
        capabilities: ['chat', 'vision', 'tools', 'reasoning'],
        contextLength: 200_000,
        priority: 90,
        costTier: 'premium',
      },
      {
        id: 'claude-haiku',
        model: 'claude-3-5-haiku-latest',
        displayName: 'Claude Haiku 3.5',
        capabilities: ['chat', 'vision', 'tools'],
        contextLength: 200_000,
        priority: 65,
        costTier: 'cheap',
      },
    ],
  },
  {
    id: 'gemini',
    displayName: 'Google Gemini',
    kind: 'gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    envKey: 'GEMINI_API_KEY',
    envBaseUrl: 'GEMINI_BASE_URL',
    priority: 85,
    models: [
      {
        id: 'gemini-main',
        model: 'gemini-2.0-flash',
        displayName: 'Gemini 2.0 Flash',
        capabilities: ['chat', 'vision', 'tools'],
        contextLength: 1_000_000,
        priority: 85,
        costTier: 'cheap',
      },
      {
        id: 'gemini-pro',
        model: 'gemini-1.5-pro',
        displayName: 'Gemini 1.5 Pro',
        capabilities: ['chat', 'vision', 'tools', 'reasoning'],
        contextLength: 2_000_000,
        priority: 70,
        costTier: 'standard',
      },
    ],
  },
  {
    id: 'xai',
    displayName: 'xAI Grok',
    kind: 'openai-compatible',
    defaultBaseUrl: 'https://api.x.ai/v1',
    envKey: 'XAI_API_KEY',
    envBaseUrl: 'XAI_BASE_URL',
    priority: 70,
    models: [
      {
        id: 'grok-main',
        model: 'grok-3',
        displayName: 'Grok 3',
        capabilities: ['chat', 'tools'],
        contextLength: 131_072,
        priority: 70,
        costTier: 'standard',
      },
    ],
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    kind: 'openai-compatible',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
    envBaseUrl: 'OPENROUTER_BASE_URL',
    priority: 50,
    extraHeaders: { 'x-title': 'llm-router' },
    models: [
      {
        id: 'openrouter-auto',
        model: 'openrouter/auto',
        displayName: 'OpenRouter Auto',
        capabilities: ['chat', 'tools'],
        contextLength: 128_000,
        priority: 50,
        costTier: 'standard',
      },
    ],
  },
  {
    id: 'qwen',
    displayName: 'Qwen (DashScope)',
    kind: 'openai-compatible',
    defaultBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    envKey: 'QWEN_API_KEY',
    envBaseUrl: 'QWEN_BASE_URL',
    priority: 55,
    models: [
      {
        id: 'qwen-main',
        model: 'qwen-plus',
        displayName: 'Qwen Plus',
        capabilities: ['chat', 'tools'],
        contextLength: 131_072,
        priority: 55,
        costTier: 'cheap',
      },
    ],
  },
  {
    id: 'glm',
    displayName: 'Zhipu GLM',
    kind: 'openai-compatible',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    envKey: 'GLM_API_KEY',
    envBaseUrl: 'GLM_BASE_URL',
    priority: 45,
    models: [
      {
        id: 'glm-main',
        model: 'glm-4-plus',
        displayName: 'GLM-4 Plus',
        capabilities: ['chat', 'tools'],
        contextLength: 128_000,
        priority: 45,
        costTier: 'cheap',
      },
    ],
  },
];

/** Instantiate the adapter for a provider definition. */
export function createProvider(def: {
  id: string;
  kind: ProviderKind;
  models?: readonly string[];
  extraHeaders?: Record<string, string>;
}): Provider {
  switch (def.kind) {
    case 'anthropic':
      return new AnthropicProvider(def.id, def.models ?? []);
    case 'gemini':
      return new GeminiProvider(def.id, def.models ?? []);
    case 'openai-compatible':
    default:
      return new OpenAICompatibleProvider(def.id, def.models ?? [], {
        extraHeaders: def.extraHeaders,
      });
  }
}

/**
 * Runtime registry of live adapter instances, keyed by provider id.
 * Adapters are stateless, so one instance per provider is enough.
 */
export class ProviderRegistry {
  private providers = new Map<string, Provider>();

  register(provider: Provider): void {
    this.providers.set(provider.name, provider);
  }

  get(id: string): Provider | undefined {
    return this.providers.get(id);
  }

  /** Get or lazily create an adapter for a configured provider. */
  ensure(id: string, kind: ProviderKind, models?: readonly string[], extraHeaders?: Record<string, string>): Provider {
    let p = this.providers.get(id);
    if (!p) {
      p = createProvider({ id, kind, models, extraHeaders });
      this.providers.set(id, p);
    }
    return p;
  }

  all(): Provider[] {
    return [...this.providers.values()];
  }

  clear(): void {
    this.providers.clear();
  }
}

/** Seed routing profiles. Every one is editable at runtime. */
export const DEFAULT_PROFILES: Array<{
  id: string;
  displayName: string;
  description: string;
  models: string[];
}> = [
  {
    id: 'general',
    displayName: 'General',
    description: 'Balanced default for everyday chat traffic',
    models: ['gemini-main', 'grok-main', 'qwen-main', 'openai-mini', 'claude-haiku'],
  },
  {
    id: 'coding',
    displayName: 'Coding',
    description: 'Code generation and review — strongest models first',
    models: ['claude-sonnet', 'openai-flagship', 'gemini-main', 'glm-main', 'qwen-main'],
  },
  {
    id: 'cheap',
    displayName: 'Cheap',
    description: 'Cost-optimised; cheapest capable model wins',
    models: ['qwen-main', 'glm-main', 'gemini-main', 'openai-mini', 'claude-haiku'],
  },
  {
    id: 'fast',
    displayName: 'Fast',
    description: 'Latency-optimised for interactive use',
    models: ['gemini-main', 'qwen-main', 'grok-main', 'claude-haiku'],
  },
  {
    id: 'reasoning',
    displayName: 'Reasoning',
    description: 'Complex multi-step reasoning',
    models: ['claude-sonnet', 'openai-flagship', 'glm-main', 'gemini-pro'],
  },
  {
    id: 'vision',
    displayName: 'Vision',
    description: 'Image understanding — vision-capable models only',
    models: ['gemini-main', 'claude-sonnet', 'openai-flagship'],
  },
];

/**
 * `auto` is a profile like any other, so operators can reorder it. It is
 * seeded pointing at `general`'s ladder.
 */
export const AUTO_PROFILE_ID = 'auto';
