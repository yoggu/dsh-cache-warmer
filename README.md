# dsh-cache-warmer

Estimated **Cache time** with a draining ring, observed cached-token usage, and opt-in cost-aware warming. Settings live in **Plugins → Cache warmer** and **Settings → Context cache**. English and Chinese UI; popup checkbox and native-style settings switch.

## Install

Requires DeepSeek Harness **0.1.7-rc.2** (the tested runtime) with the standard LLM, session projection and storage services. Install the pinned GitHub tag into your Web profile:

```sh
dsh plugin --profile web add 'https://github.com/yoggu/dsh-cache-warmer.git#v0.1.0'
```

Alternatively, clone and link a local checkout:

```sh
git clone --branch v0.1.0 https://github.com/yoggu/dsh-cache-warmer.git
cd dsh-cache-warmer
dsh plugin --profile web add "link:$(pwd)"
```

Keep a linked checkout in place. Replace `web` if your profile has a different name. Reload the GUI after installation; restart Harness if the installer requires it. Open **Plugins → Cache warmer** for defaults, then enable **Keep cache warm** in a chat's **Cache time** popup. Warming is off by default and needs a new genuine model request after installation/reload.

For Codex, also install and configure [dsh-codex-account](https://github.com/yoggu/dsh-codex-account), using the `codex-personal` or `codex-business` route. OpenRouter requires the Harness pi-ai provider and its configured credential. This plugin never copies credentials into its own files. The token-cost estimator is optional, not a runtime dependency.

To uninstall:

```sh
dsh plugin --profile web remove dsh-cache-warmer
```

## Settings and lifetime

Only three settings: `autoWarmNewChats` (false), `activeMinutes` (60), and `idleMinutes` (30). Zero disables that phase. Both deadlines are measured from the **last genuine model request**, not from refreshes or the time tools finish. Existing sessions opt in individually. Child/subagent sessions do not auto-warm.

A 30-minute estimated cache lifetime schedules a decision at minute 27. With a 30-minute idle deadline, at most one refresh is sent (only if worthwhile); a successful hit can move estimated expiry to minute 57. The deadline controls requests, not provider eviction. Longer windows may allow more refreshes; there is no arbitrary three-attempt ceiling.

Known lifetime: decision at `min(0.9 × lifetime, lifetime − 10 seconds)`. Timers recheck deadline, current context, permission, route identity and economics. New requests preempt obsolete work. Model/settings/account-route changes, replacement/compaction, cancellation and disposal invalidate captured requests. Warming never extends activity deadlines.

## Economics (same calculation for API and subscription routes)

Published prices come from the installed pi-ai catalog, the same source used by `dsh-token-cost-estimate`. Each decision uses the **current captured request's input**, not accumulated session usage. Cache-read/write counts are disjoint from uncached input. Pricing tiers use total input including cached tokens.

`expected savings = continuation probability × avoided miss cost − refresh cost`

Use Pi's probability assumptions: 100% active, 15% idle, with a $0.05 threshold. Conservatively credit only observed reusable tokens, charge the remainder at uncached input rates, and reserve output cost. Missing prices/evidence skip warming. Cheap OpenRouter DeepSeek Flash contexts usually fail the threshold, intentionally.

Codex prices are **API-equivalent heuristics**, not a bill, subscription allowance units, or proof of reduced quota usage. Its refresh reserves at least 1,024 output tokens plus a small uncached suffix in the estimate; observed larger warm outputs increase this reserve. This is not a hard output bound.

## Provider behavior

### Codex account routes

`codex-personal` and `codex-business` use the existing `dsh-codex-account` adapter through the public `llm.prepareCall` contract. Authentication, account mapping, replay metadata, files/images and serialization stay with that adapter. The background request preserves the original request prefix/model/session key/tools/reasoning and appends a request-only “Reply only OK. Do not use tools.” message. **Neither prompt nor output enters chat history; no returned tool calls are executed.** Only usage and sanitized finish metadata are consumed.

The inspected account adapter requests one attempt (`maxRetries: 0`); Harness retries belong to AgentLoop, which warming does not enter. SSE makes one network attempt; WebSocket/auto can still perform native connection fallback/recovery. A ten-second cancellation deadline is additionally shortened to the remaining activity window. Codex does not honor a hard `maxTokens` cap; a short instruction and client cancellation are not a billing guarantee. Errors/cache misses stop that captured target until a genuine request replaces it.

CodexZero-derived estimates: 30 minutes for reviewed modern families (`gpt-6-astra/sol/luna`, `gpt-5.5`, `gpt-5.6` variants, `gpt-daybreak-blue-latest`); five minutes for reviewed GPT-5 through GPT-5.4 legacy/Codex names. Unknown families have no countdown or automatic schedule. These are approximate family assumptions, **not server-reported TTLs**. Reset estimates on observed cache-read/write evidence, not merely HTTP success or an attempted refresh. Elapsed estimate does not prove eviction.

Route/account configuration and owner changes invalidate snapshots. Limitation: replacing credentials under the same configured account id does not expose a credential-generation event in `dsh-codex-account`; fresh credentials remain resolved by that owner. Changed native attachment projection can also affect cache reuse. A miss stops recurrence rather than claiming success.

### OpenRouter / DeepSeek

Exact route `openrouter/~deepseek/deepseek-v4-flash-latest` with the default catalog endpoint and configured credential reference. Custom endpoints/headers/model overrides fail closed. Previous authorized synthetic requests established cache reuse, not retention or an end-to-end scheduled live result.

Expiry stays **unknown**: the five-minute best-effort **decision cadence is not a TTL**, so the ring remains an outline and shows `Cache time —`. Pi's cost gate applies at every candidate. At most eight output tokens, no retries, ten-second deadline, 1 MiB serialized-request ceiling. Routing retains price caps ($1/M prompt, $2/M completion, zero request fee), required parameters and no fallbacks. These are transport guardrails, not additional user settings or a monetary guarantee. No arbitrary user budget is exposed.

Other routes remain observation-only until an appropriate transport and retention policy are reviewed. Provider caching itself can work without automatic warming.

## Accounting and persistence

Per-session opt-in and aggregate warm usage are stored in separate plugin storage domains. The popup shows warm attempts and the separately accounted API-equivalent cost; incomplete/aborted requests without usage are marked unpriced. Warm usage is **not added to ordinary transcript-derived token-cost totals**. Request bodies, prompts and credentials are not persisted by this plugin. Restart/reload needs a new genuine request before automatic warming resumes; historical evidence may still display an estimated countdown.

## Verification

`npm test` covers economics, model-family estimates, the 27/30-minute timeline, lifecycle cancellation, failures, repeated refreshes, persistence, no transcript/tool execution, and loopback wire tests using the actual installed Codex account adapter and OpenRouter serializer. Synthetic credentials are confined to loopback; the suite sends no paid requests. Live scheduled cache benefit is not established by offline tests and requires a separately authorized provider test.

The integration tests require the tested Harness dependencies and a sibling `dsh-codex-account` checkout with its dependencies installed. They exercise the locally installed adapters, not a self-contained mock of the providers.

## License

MIT; see [LICENSE](LICENSE).

## References

- [Pi cache warming](https://github.com/earendil-works/pi/blob/v0.86.0/packages/coding-agent/docs/settings.md#cache-warming)
- [Pi provider lifetime configuration](https://github.com/earendil-works/pi/blob/v0.86.0/packages/coding-agent/docs/models.md#prompt-cache-lifetimes)
- [CodexZero lifetime estimates](https://github.com/Retro2512/CodexZero/blob/c6683582435ae476e29b1446cdc230779cd7b5e1/src/cache-accounting.mjs)
- [CodexZero warming](https://github.com/Retro2512/CodexZero/blob/c6683582435ae476e29b1446cdc230779cd7b5e1/src/cache-monitor.mjs)
- [DeepSeek caching](https://api-docs.deepseek.com/guides/kv_cache/)
- [OpenRouter caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
