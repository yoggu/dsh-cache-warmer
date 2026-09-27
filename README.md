# dsh-cache-warmer

Session cache observations and opt-in, bounded OpenRouter warming. Settings are available in **Plugins → Cache warmer** and **Settings → Context cache**.

## Supported behavior

- Exact route `openrouter/~deepseek/deepseek-v4-flash-latest`, with the default catalog endpoint and an explicit configured credential reference. Custom endpoints, model overrides and headers fail closed.
- A user-authorized three-request synthetic test returned 1,318 input tokens initially and 1,152 cached tokens on each subsequent request. This establishes synthetic reuse, not a guaranteed expiry or end-to-end real-conversation warming result.
- Neither DeepSeek/OpenRouter nor the installed Codex transport exposes exact cache expiry. The UI shows last-hit time; unknown expiry remains unknown. Refresh interval is independent of TTL.
- Codex remains observation-only: its installed transport does not serialize the output limit. Its `long` setting does not establish 24-hour retention. Public OpenAI prewarm support is not proof of support on the ChatGPT Codex backend.

## Safety and limits

Warming defaults off. Enabling a session allows billable shadow calls, never agent turns or tool execution. A genuine request supplies the exact prefix, tools, reasoning settings and session identifier. New requests, resumed activity, changed history and disposal cancel obsolete work. Requests are not persisted for restart replay.

Each genuine request prefix has at most three refresh attempts, at most eight output tokens each, no transport retries, and a 10-second host deadline. Errors and cache misses stop further attempts for that prefix. OpenRouter routing enforces maximum prices of $1/M input and $2/M output, zero per-request fee, required parameters and no fallbacks. A configurable budget derives a conservative serialized-input byte limit (twice the byte count plus framing allowance). This is a conservative reservation, not a provider tokenizer or invoice guarantee. Oversized prompts are rejected before network I/O. Independent input ceiling: 1 MiB. Paid probes need separate authorization.

## Configuration

```yaml
- insert:
    - id: dsh-cache-warmer
      name: dsh-cache-warmer
      config:
        autoWarmNewChats: false
        activeMinutes: 60
        idleMinutes: 30
        refreshMinutes: 5
        maxBudgetUsd: 1
```

A zero active/idle window disables that phase. Budget range: $0.05–$10 per genuine request prefix, not per session; refresh interval: 1–60 minutes. Existing sessions require explicit opt-in. Small budgets may reject normal Harness contexts.

## References

- https://api-docs.deepseek.com/guides/kv_cache/
- https://openrouter.ai/docs/guides/best-practices/prompt-caching
- https://openrouter.ai/docs/guides/routing/provider-selection
- https://developers.openai.com/api/docs/guides/prompt-caching

Run `npm test` for policy, cancellation and loopback wire tests. No tests in that suite send paid requests.
