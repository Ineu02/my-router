import { OpenAICompatibleProvider } from './openai-compatible.js';
import type { ProviderCallOptions } from './types.js';

/**
 * Adapter for OAuth-authenticated ChatGPT/Codex accounts.
 *
 * Wire format is plain OpenAI chat/completions — everything inherited from
 * {@link OpenAICompatibleProvider} applies. The only differences are:
 *
 *  1. The bearer is a short-lived OAuth *access token*, not a static API key.
 *     The engine resolves it per-call via the TokenManager and passes it as
 *     `opts.apiKey`, so nothing here changes about how the header is built.
 *  2. ChatGPT's backend needs the account the token belongs to identified with
 *     a `chatgpt-account-id` header. The engine puts the id in `opts.headers`;
 *     this adapter promotes it to the canonical header name.
 *
 * NOTE: the real ChatGPT backend serves Codex over a *Responses* API, not
 * `/v1/chat/completions`. Translating that wire format (and its streaming shape)
 * is a documented follow-up — it can't be exercised locally without a real,
 * billable login. Against an OpenAI-compatible endpoint (including the local
 * mock) this adapter works as-is, which is what the test suite covers.
 */
export class OpenAICodexProvider extends OpenAICompatibleProvider {
  override readonly kind = 'openai-codex' as const;

  protected override buildHeaders(opts: ProviderCallOptions): Record<string, string> {
    const headers = super.buildHeaders(opts);
    // The engine passes the account id through opts.headers; normalise it onto
    // the header ChatGPT expects and drop the transport-only alias.
    const accountId = opts.headers?.['chatgpt-account-id'] ?? opts.headers?.['x-codex-account-id'];
    if (accountId) headers['chatgpt-account-id'] = accountId;
    delete headers['x-codex-account-id'];
    return headers;
  }
}
