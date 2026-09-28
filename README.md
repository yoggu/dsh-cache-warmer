# dsh-cache-warmer

Estimated **Cache time** with a draining ring, observed cached-token usage, and opt-in cost-aware warming. Settings live only in **Plugins → Cache warmer**, not the global Settings modal. English and Chinese UI; popup checkbox and native-style settings switch.

## Install

Requires DeepSeek Harness **0.1.7-rc.2** (the tested runtime) with the standard LLM, session projection and storage services. Install the pinned GitHub tag into your Web profile:

```sh
dsh plugin --profile web add 'https://github.com/yoggu/dsh-cache-warmer.git#v0.1.4'
```

Alternatively, clone and link a local checkout:

```sh
git clone --branch v0.1.4 https://github.com/yoggu/dsh-cache-warmer.git
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

The three basic settings remain `autoWarmNewChats` (false), `activeMinutes` (60), and `idleMinutes` (30). Zero disables that phase. Both deadlines are measured from the **last genuine model request**, not from refreshes or the time tools finish. Existing sessions opt in individually. Child/subagent sessions do not auto-warm.

A 30-minute estimated cache lifetime schedules a decision at minute 27. With a 30-minute idle deadline, at most one refresh is sent (only if worthwhile); a successful hit can move estimated expiry to minute 57. The deadline controls requests, not provider eviction. Longer windows may allow more refreshes; there is no arbitrary three-attempt ceiling.

Known lifetime: decision at `min(0.9 × lifetime, lifetime − 10 seconds)`. Timers recheck deadline, current context, permission, route identity and economics. New requests preempt obsolete work. Model/settings/account-route changes, replacement/compaction, cancellation and disposal invalidate captured requests. Warming never extends activity deadlines.

### Models and cache policies

**Plugins → Cache warmer → Model cache policies** automatically lists the models advertised by all registered Harness provider routes, including Codex accounts, pi-ai providers, and DeepSeek. Search by model/provider or filter by provider; refresh the catalog after changing provider configuration. No manual model IDs are needed. Discovery lists advertised models, not proof of authentication or caching support. An unavailable provider does not erase saved overrides. Providers share a five-second discovery deadline; browser settings and model-list reads have a ten-second timeout with Retry, including stalled response bodies. A failed refresh preserves the last model list and unsaved settings rather than leaving the page loading indefinitely.

Known Codex lifetime estimates are filled automatically, with no global defaults switch. Each model has:

- **Enable warming**: permits warming for this model; turning it off preserves its lifetime. Per-chat opt-in still applies.
- **Estimated cache lifetime (minutes)**: an integer from 1 to 10080. Blank means **unknown**, so no automatic warming is sent even when enabled.
- **Reset to default**: restores the known estimate and enablement (or unknown/disabled for models without defaults).
- A transport status: unsupported models remain visible with an explanation rather than disappearing from the list.

Only your exact provider/model overrides are saved in `modelPolicies`, not the discovered catalog. Duplicate pairs are rejected; at most 100 overrides. A custom rule replaces the default, including blank or disabled values. A disabled model can still display an estimated countdown and observed cache hits, but sends no refresh.

Changing a lifetime does **not** change the provider's requested retention or guarantee an expiry; all values are local planning assumptions. Provider-side caching disabled (`cacheRetention: none`) still blocks scheduling. Saving settings cancels captured targets; a new genuine request is required before warming resumes.

Compatibility: existing `enabled: false` rules retain their lifetimes and remain disabled. An older `useCodexDefaults: false` setting is respected internally rather than silently re-enabling models; resetting an individual known model explicitly restores its default. Old `shortMinutes`/`longMinutes` rows migrate conservatively: two known values become the smaller value; if either is unknown, the unified value remains unknown. Saving writes the single `cacheMinutes` field. Mixing old and new lifetime fields in one row is rejected.

Example saved override (an illustrative assumption, not an OpenRouter TTL claim):

```json
{
  "modelPolicies": [
    {
      "provider": "openrouter",
      "model": "~deepseek/deepseek-v4-flash-latest",
      "enabled": true,
      "cacheMinutes": 5
    }
  ]
}
```

A lifetime cannot add a refresh transport. Compatible OpenRouter Chat Completions catalog models and the two Codex account routes have transports; other providers and unsupported protocols stay visible but observation-only. A refresh still requires cache evidence, known prices, the savings threshold and an unexpired activity window.

## Economics (same calculation for API and subscription routes)

Published prices come from the installed pi-ai catalog, the same source used by `dsh-token-cost-estimate`. Each decision uses the **current captured request's input**, not accumulated session usage. Cache-read/write counts are disjoint from uncached input. Pricing tiers use total input including cached tokens.

`expected savings = continuation probability × avoided miss cost − refresh cost`

Defaults use Pi's probability assumptions: 100% active, 15% idle, with a $0.05 minimum expected net benefit. **Plugins → Cache warmer → Advanced → Cost checks** exposes:

- `minExpectedBenefitUsd` — minimum expected **net** benefit after subtracting refresh cost; defaults to `0.05`, accepts finite numbers from `0` to `1000` USD. This is not a spending budget.
- `idleContinuationPercent` — assumed chance of continuing while idle; defaults to `15`, accepts whole percentages from `0` to `100`. This is a fixed planning assumption, not a learned prediction. Zero disables idle warming; the active assumption remains 100%.

Lowering the minimum or raising idle probability can increase warming and usage. These settings change whether a refresh is worthwhile, not the cache lifetime or decision timing. Older clients that omit them preserve current values. Saving cancels captured targets and requires a new genuine request, as with other warming settings.

Conservatively credit only observed reusable tokens, charge the remainder at uncached input rates, and reserve output cost. Missing prices/evidence still prevent warming, including with a zero threshold. Cheap OpenRouter DeepSeek Flash contexts usually fail the default threshold, intentionally.

Codex prices are **API-equivalent heuristics**, not a bill, subscription allowance units, or proof of reduced quota usage. Its refresh reserves at least 1,024 output tokens plus a small uncached suffix in the estimate; observed larger warm outputs increase this reserve. This is not a hard output bound.

## Provider behavior

### Codex account routes

`codex-personal` and `codex-business` use the existing `dsh-codex-account` adapter through the public `llm.prepareCall` contract. Authentication, account mapping, replay metadata, files/images and serialization stay with that adapter. The background request preserves the original request prefix/model/session key/tools/reasoning and appends a request-only “Reply only OK. Do not use tools.” message. **Neither prompt nor output enters chat history; no returned tool calls are executed.** Only usage and sanitized finish metadata are consumed.

The inspected account adapter requests one attempt (`maxRetries: 0`); Harness retries belong to AgentLoop, which warming does not enter. SSE makes one network attempt; WebSocket/auto can still perform native connection fallback/recovery. A ten-second cancellation deadline is additionally shortened to the remaining activity window. Codex does not honor a hard `maxTokens` cap; a short instruction and client cancellation are not a billing guarantee. Errors/cache misses stop that captured target until a genuine request replaces it.

CodexZero-derived estimates: 30 minutes for reviewed modern families (`gpt-6-astra/sol/luna`, `gpt-5.5`, `gpt-5.6` variants, `gpt-daybreak-blue-latest`); five minutes for reviewed GPT-5 through GPT-5.4 legacy/Codex names. Unknown families have no default countdown or automatic schedule, but can receive an exact custom lifetime rule. Built-in defaults apply automatically and custom rules take precedence; legacy global opt-outs remain respected. These are approximate family assumptions, **not server-reported TTLs**. Reset estimates on observed cache-read/write evidence, not merely HTTP success or an attempted refresh. Elapsed estimate does not prove eviction.

Route/account configuration and owner changes invalidate snapshots. Limitation: replacing credentials under the same configured account id does not expose a credential-generation event in `dsh-codex-account`; fresh credentials remain resolved by that owner. Changed native attachment projection can also affect cache reuse. A miss stops recurrence rather than claiming success.

### OpenRouter

Compatible models from the installed OpenRouter catalog use their own native Chat Completions serializer and compatibility settings, bound to the exact selected model. The previous single DeepSeek-model allowlist is removed. Native Anthropic-protocol models, dynamic router/search aliases, unknown pricing or unreviewed serialization capabilities remain unsupported, with a reason shown in the model list. Custom endpoints/headers/model overrides fail closed. Other provider routes (including direct DeepSeek) are discoverable but do not yet have a warming transport.

Expiry defaults to **unknown** for OpenRouter. Enable the model and configure an estimated lifetime to permit cost-aware scheduling; per-chat opt-in still applies. At most eight output tokens, no retries, ten-second deadline, and a 1 MiB serialized-request ceiling. Text/tool context only; attachment requests are rejected rather than silently altered. No tool calls are executed.

Routing requires parameters, forbids fallbacks and request fees, and derives prompt/completion price ceilings from the selected model's installed catalog prices across tiers. It no longer imposes the old $1/M prompt and $2/M completion ceiling on every model. These are transport guardrails, not user-facing budgets or a billing guarantee. Missing cache evidence/prices or insufficient expected savings still prevent warming.

Previous authorized synthetic DeepSeek requests established cache reuse, not retention or an end-to-end scheduled live result. Generalized transports are verified with loopback requests, not paid inference. Provider caching itself can work without automatic warming.

## Accounting and persistence

Per-session opt-in and aggregate warm usage are stored in separate plugin storage domains. The popup shows warm attempts and the separately accounted API-equivalent cost; incomplete/aborted requests without usage are marked unpriced. Warm usage is **not added to ordinary transcript-derived token-cost totals**. Request bodies, prompts and credentials are not persisted by this plugin. Restart/reload needs a new genuine request before automatic warming resumes; historical evidence may still display an estimated countdown.

## Request capture and diagnostics

Capture requires the exact AgentLoop request identity, not merely a matching session id or message shape. Linked installations can have a second copy of the Harness LLM peer dependency; its request-marker registry is separate from the running host's. The warmer resolves the public marker from the module owning the injected `LlmRuntime` (verified with `instanceof`), using the running executable as a fallback resolution anchor. If the owner cannot be resolved in an unusual embedded layout, warming fails closed with an explicit diagnostic.

The popup shows **Cache warming** at the top left and a concise warming status at the top right: **Scheduled**, **Warming**, **Waiting**, **Skipped**, **Stopped**, **Disabled**, or **Unavailable**, followed by a short description underneath. Dollar estimates remain in separate rows rather than being appended to the status. The **Keep cache warm** checkbox sits above all information rows. **Cache lifetime** shows the lifetime assumption; **Time remaining** shows the estimated countdown. The redundant active/idle phase row is omitted. Scheduled means an actual timer exists and current checks pass; conditions are checked again before sending. A worthwhile estimate or countdown alone does not mean a refresh is scheduled.

The popup distinguishes an absent snapshot from a captured request still in progress. The authenticated status endpoint also reports `warmingState`, `requestCaptured`, `requestCompleted`, `lastRequestCompletedAt`, and `nextRefreshAt`. A completed request can correctly produce an economic skip, especially while idle.

## Verification

`npm test` covers automatic model discovery, partial failures/timeouts, bilingual searchable settings, per-model enablement and defaults, economics, model-family estimates, the 27/30-minute timeline, lifecycle cancellation, failures, repeated refreshes, persistence, no transcript/tool execution, and loopback wire tests using the actual installed Codex account adapter and OpenRouter serializer. Synthetic credentials are confined to loopback; the suite sends no paid requests. Live scheduled cache benefit is not established by offline tests and requires a separately authorized provider test.

The integration tests require the tested Harness dependencies and a sibling `dsh-codex-account` checkout with its dependencies installed. They exercise the locally installed adapters, not a self-contained mock of the providers. Cross-peer identity tests run through the real Cordis proxy and prepared-call waterfall; they explicitly report a skip when the test installation is deduplicated and cannot reproduce the separate-registry layout.

## License

MIT; see [LICENSE](LICENSE).
