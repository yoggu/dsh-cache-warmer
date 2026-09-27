import * as localLlm from '@deepseek-ai/dsh-llm'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * The request marker is a module-local WeakSet, not a property on the request.
 * A linked plugin can have its own peer copy. Only use the public marker from
 * the module whose LlmRuntime actually owns the injected service. Never accept
 * a request by shape, purpose, frozen state, or a copied marker alone.
 *
 * The running executable is a resolution anchor, not a hard-coded DSH path.
 * Unknown/embedded layouts fail closed rather than treating all calls as LOOP.
 */
export async function resolveRequestIdentity(runtime, entryPoint = process.argv[1]) {
  const matches = api => typeof api.LlmRuntime === 'function'
    && runtime instanceof api.LlmRuntime && typeof api.isAgentLoopRequest === 'function'
  if (matches(localLlm)) return localLlm.isAgentLoopRequest
  if (typeof entryPoint !== 'string' || !isAbsolute(entryPoint)) return null
  try {
    const require = createRequire(realpathSync(entryPoint))
    const api = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href)
    return matches(api) ? api.isAgentLoopRequest : null
  } catch { return null }
}
