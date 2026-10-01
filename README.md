# dsh-cache-warmer

Estimated **Cache time** with a draining ring, observed cached-token usage, and opt-in cost-aware warming. Settings live only in **Plugins → Cache warmer**, not the global Settings modal. English and Chinese UI; popup checkbox and native-style settings switch.

## Requirements and installation

The current implementation requires a compatible Harness runtime with its standard LLM, session projection, credentials and storage services, plus the shipped pi-ai adapter. Native warming is reviewed against **llm-pi-ai 0.2.0-rc.2 / pi-ai 0.99.1**; a different adapter or serializer version fails closed until reviewed. The historical bounded OpenRouter path additionally checks its catalog snapshot. There is no separate pi-ai dependency to upgrade in this plugin.

Install the latest tagged GitHub release:

```sh
dsh plugin --profile web add 'https://github.com/yoggu/dsh-cache-warmer.git#v0.1.7'
```

Or link a local checkout:

```sh
git clone --branch v0.1.7 --depth 1 https://github.com/yoggu/dsh-cache-warmer.git
cd dsh-cache-warmer
dsh plugin --profile web add "link:$(pwd)"
```

Keep linked checkouts in place while installed. Restart DSH after replacing an installed package version, then refresh the browser. Existing older tags do not contain all current safeguards. Warming remains **off by default** and requires a new genuine model request, explicit model enablement with an estimated lifetime, and per-chat opt-in. Updating or installing the plugin does not itself make a warming request.

The current checkout uses the owning **llm-pi-ai native provider route**, including API-key and OAuth authentication. Compatible text-chat models can warm regardless of provider name; non-pi-ai adapters remain observation-only. Versions up to `v0.1.6` predate this native-provider extension. No optional `modelPricing` service is required. The plugin reuses native credential resolution and OAuth refresh without copying credentials into its own files.

**Codex / signed-in Responses:** these routes do not guarantee a server-side output cap. Enable **Allow best-effort warming (Codex / OAuth)** separately in plugin settings, as well as the model policy and per-chat consent. This is off by default, including for historical saved policies. Client cancellation does not guarantee that hidden reasoning or provider generation stops, and cost estimates are not spending or quota caps.

## Settings and lifetime

The three basic settings remain `autoWarmNewChats` (false), `activeMinutes` (60), and `idleMinutes` (30). Zero disables that phase. Both deadlines are measured from the **last genuine model request**, not from refreshes or the time tools finish. Existing sessions opt in individually. Child/subagent sessions do not auto-warm.

A 30-minute estimated cache lifetime schedules a decision at minute 27. With a 30-minute idle deadline, at most one refresh is sent (only if worthwhile); a successful hit can move estimated expiry to minute 57. The deadline controls requests, not provider eviction. Longer windows may allow more refreshes; there is no arbitrary three-attempt ceiling.

Known lifetime: decision at `min(0.9 × lifetime, lifetime − 10 seconds)`. Timers recheck deadline, current context, permission, route identity and economics. New requests preempt obsolete work. Model/settings/account-route changes, replacement/compaction, cancellation and disposal invalidate captured requests. Warming never extends activity deadlines.

### Models and cache policies

**Plugins → Cache warmer → Model cache policies** automatically lists the models advertised by all registered Harness provider routes, including Codex accounts, pi-ai providers, and DeepSeek. Search by model/provider or filter by provider; refresh the catalog after changing provider configuration. No manual model IDs are needed. Discovery lists advertised models, not proof of authentication or caching support. An unavailable provider does not erase saved overrides. Providers share a five-second discovery deadline; browser settings and model-list reads have a ten-second timeout with Retry, including stalled response bodies. A failed refresh preserves the last model list and unsaved settings rather than leaving the page loading indefinitely.

No provider-reported lifetime or built-in Codex lifetime is assumed. Each model has:

- **Enable warming**: permits warming for this model; turning it off preserves its lifetime. Per-chat opt-in still applies.
- **Estimated cache lifetime (minutes)**: an integer from 1 to 10080. Blank means **unknown**, so no automatic warming is sent even when enabled.
- **Reset to default**: restores unknown lifetime and disabled warming. Historical Codex rules never enable a transport.
- A transport status: unsupported models remain visible with an explanation rather than disappearing from the list.

Only your exact provider/model overrides are saved in `modelPolicies`, not the discovered catalog. Duplicate pairs are rejected; at most 100 overrides. A custom rule replaces the default, including blank or disabled values. A disabled model can still display an estimated countdown and observed cache hits, but sends no refresh. Observation-only routes, including Codex when native warming is unavailable or consent is off, display an explicitly configured lifetime even without a reported retention mode; the countdown requires an observed cache hit and does not enable background warming.

Changing a lifetime does **not** change the provider's requested retention or guarantee an expiry; all values are local planning assumptions. Provider-side caching disabled (`cacheRetention: none`) still blocks scheduling. Saving settings cancels captured targets; a new genuine request is required before warming resumes.

Compatibility: existing `enabled: false` rules retain their displayed lifetimes and remain disabled. The older `useCodexDefaults` field is accepted for settings compatibility but no longer grants account-route warming. Old `shortMinutes`/`longMinutes` rows migrate conservatively: two known values become the smaller value; if either is unknown, the unified value remains unknown. Saving writes the single `cacheMinutes` field. Mixing old and new lifetime fields in one row is rejected.

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

A lifetime cannot add a refresh transport. Admission uses the actual registered llm-pi-ai adapter and its exact configured native model, not a provider-name allowlist. Compatible native protocols can warm; unsupported protocols, non-chat models and non-pi-ai routes stay visible with a reason. A refresh still requires cache evidence, known prices, the savings threshold and an unexpired activity window. Bedrock currently remains unavailable because its native SDK cannot disable retries through this seam.

## Economics (independent from warming permission)

Published list-price hypotheticals use `calculateCost` from the **owning `@deepseek-ai/dsh-llm-pi-ai` adapter's own reviewed pi-ai copy**, with fresh usage and cost objects for each hypothetical. There is no `modelPricing` dependency, and a pricing estimate never adds a warming transport. Native admission rechecks the actual adapter, snapshot and exact model before sending; missing, unknown, changed, malformed or non-finite costs fail closed. Custom endpoint/protocol overrides do not inherit verified billing just because their model ID matches the catalog. Anthropic long-retention writes are priced at the one-hour write rate; an unreported tier is conservatively treated as long for write accounting. Custom models without known prices are not treated as free. Each decision uses the **current captured request's input**, not accumulated session usage. Cache-read/write counts are disjoint from uncached input; native price tiers are handled by pi-ai.

`expected savings = continuation probability × avoided miss cost − refresh cost`

Defaults use Pi's probability assumptions: 100% active, 15% idle, with a $0.05 minimum expected net benefit. **Plugins → Cache warmer → Advanced → Cost checks** exposes:

- `minExpectedBenefitUsd` — minimum expected **net** benefit after subtracting refresh cost; defaults to `0.05`, accepts finite numbers from `0` to `1000` USD. This is not a spending budget.
- `idleContinuationPercent` — assumed chance of continuing while idle; defaults to `15`, accepts whole percentages from `0` to `100`. This is a fixed planning assumption, not a learned prediction. Zero disables idle warming; the active assumption remains 100%.

Lowering the minimum or raising idle probability can increase warming and usage. These settings change whether a refresh is worthwhile, not the cache lifetime or decision timing. Older clients that omit them preserve current values. Saving cancels captured targets and requires a new genuine request, as with other warming settings.

Conservatively credit only observed reusable tokens, charge the remainder at uncached input rates, and reserve output cost. Missing prices/evidence still prevent warming, including with a zero threshold. Cheap OpenRouter DeepSeek Flash contexts usually fail the default threshold, intentionally.

Cost projections are **API-equivalent list-price estimates**, not a bill or proof of reduced quota use. Native refreshes reserve a planning output allowance plus extra uncached input for a short keepalive suffix, preserving the captured message prefix. Server-bounded serializers validate their final output cap; Codex and possibly OAuth Responses are client-bounded only. Their output allowance is a heuristic, not a guaranteed maximum bill. Aborted requests without trustworthy usage remain unpriced. The historical offline OpenRouter transport reserves eight output tokens and preserves the prefix without a suffix.

## Provider behavior

### Native pi-ai routes

The plugin resolves the actual adapter owning the selected route, reuses its immutable native profile/model and its existing authentication context, and constructs an isolated refresh capability. This preserves native replay, tool schemas, reasoning controls and session affinity without executing tools or modifying the transcript. Cache-affecting reasoning or tool-choice settings are not silently rewritten to achieve a smaller request. A request whose required native thinking budget cannot fit the refresh bound is reported unavailable instead. Adapter internals and serializers are version-reviewed; drift fails closed. Attachments and provider-side billed tools are not silently converted into ordinary text refreshes.

Codex uses SSE to avoid sharing WebSocket continuation state. It requests a tiny reply and has a client deadline/output guard, but its backend provides no guaranteed output-token cap. Its separate best-effort consent is mandatory. Non-pi-ai `deepseek-official` and retired custom account adapters remain observation-only; an equivalent model configured through llm-pi-ai can be admitted according to its native protocol.

### OpenRouter

OpenRouter uses exact native-provider admission with mandatory provider-routing guards: supported output parameters, no fallbacks or request fees, and catalog-derived price ceilings. The reviewed native Chat Completions serializer can express these controls; OpenRouter Anthropic, Responses and other serializers remain observation-only until an equivalent routing seam is reviewed. Configured endpoints and headers come from the owning adapter, never guessed configuration. Dynamic router aliases such as `auto`, `openrouter/free` and `openrouter/fusion`, unknown billing and unreviewed serializer capabilities fail closed. Concrete, catalog-verified free models are distinct from dynamic aliases. The historical bounded OpenRouter implementation remains for compatibility/offline verification; its pinned catalog does not authorize unrelated native providers.

Expiry defaults to **unknown** for every native route. Enable the model and configure an estimated lifetime to permit cost-aware scheduling; per-chat opt-in still applies. Native refreshes have a ten-second client deadline and a 1 MiB serialized-request ceiling. Output caps are protocol-dependent and checked after native serialization; client-only routes need additional consent. Text/tool context only; attachment requests are rejected rather than silently altered. No tool calls are executed.

Routing requires parameters, forbids fallbacks and request fees, and derives prompt/completion price ceilings from the selected model's installed catalog prices across tiers. It no longer imposes the old $1/M prompt and $2/M completion ceiling on every model. These are transport guardrails, not user-facing budgets or a billing guarantee. Missing cache evidence/prices or insufficient expected savings still prevent warming.

Previous authorized synthetic DeepSeek requests established cache reuse, not retention or an end-to-end scheduled live result. Generalized transports are verified with loopback requests, not paid inference. Provider caching itself can work without automatic warming.

## Accounting and persistence

Per-session opt-in and aggregate warm usage are stored in separate plugin storage domains. The popup shows warm attempts and the separately accounted API-equivalent cost; incomplete/aborted requests without usage are marked unpriced. Warm usage is **not added to ordinary transcript-derived token-cost totals**. Request bodies, prompts and credentials are not persisted by this plugin. Restart/reload needs a new genuine request before automatic warming resumes; historical evidence may still display an estimated countdown. Credential/account updates invalidate captured requests and cache evidence as well; OAuth record rotation is conservatively included.

## Request capture and diagnostics

Capture requires the exact AgentLoop request identity, not merely a matching session id or message shape. Linked installations can have a second copy of the Harness LLM peer dependency; its request-marker registry is separate from the running host's. The warmer resolves the public marker from the module owning the injected `LlmRuntime` (verified with `instanceof`), using the running executable as a fallback resolution anchor. If the owner cannot be resolved in an unusual embedded layout, warming fails closed with an explicit diagnostic.

The popup shows **Cache warming** at the top left and a concise warming status at the top right: **Scheduled**, **Warming**, **Waiting**, **Skipped**, **Stopped**, **Disabled**, or **Unavailable**, followed by a short description underneath. Dollar estimates remain in separate rows rather than being appended to the status. The **Keep cache warm** checkbox sits above all information rows. **Cache lifetime** shows the lifetime assumption; **Time remaining** shows the estimated countdown. The redundant active/idle phase row is omitted. Scheduled means an actual timer exists and current checks pass; conditions are checked again before sending. A worthwhile estimate or countdown alone does not mean a refresh is scheduled.

The popup distinguishes an absent snapshot from a captured request still in progress. The authenticated status endpoint also reports `warmingState`, `requestCaptured`, `requestCompleted`, `lastRequestCompletedAt`, and `nextRefreshAt`. A completed request can correctly produce an economic skip, especially while idle.

## Verification

`npm test` covers automatic model discovery, partial failures/timeouts, bilingual searchable settings, per-model enablement, independent economics, observation-only routes, the 27/30-minute timeline, lifecycle cancellation, failures, repeated refreshes, persistence, no transcript/tool execution, and loopback wire tests using the actual shipped OpenRouter and native Completions, Responses, Azure, Codex, Anthropic, Google Generative/Vertex, Mistral and pi-messages serializers. Native tests cover original cache-affecting controls, credential authority, retryable errors, output limits and stalled-stream deadlines. Synthetic credentials are confined to loopback; the suite sends no paid requests. Live scheduled cache benefit is not established by offline tests and requires a separately authorized provider test.

Integration tests require the tested Harness dependencies and reviewed pi-ai adapter; they do not require a custom Codex account adapter. The development lockfile and root npm override pin pi-ai 0.99.1 for reproducible standalone tests. This checkout-level override does not upgrade or replace the adapter owned by a running Harness; runtime admission still checks its actual versions. Cross-peer identity tests run through the real Cordis proxy and prepared-call waterfall; they explicitly report a skip when the test installation is deduplicated and cannot reproduce the separate-registry layout.

## License

MIT; see [LICENSE](<LICENSE>).
