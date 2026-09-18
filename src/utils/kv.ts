import { KVNamespace } from '@cloudflare/workers-types'

/**
 * Fault-tolerant Cloudflare KV helpers used for caching the 123pan access token and
 * path -> fileId mappings. The KV namespace must be bound as PAN_INDEX_KV on your
 * deployment (Workers project -> Settings -> Bindings).
 *
 * Bindings are only reachable through the OpenNext Cloudflare context; OpenNext hydrates
 * plain environment variables into process.env, but KV namespaces are not part of that.
 *
 * All operations are best-effort: when KV is unavailable (e.g. plain `next dev` without a
 * binding) reads return null and writes are silently skipped, so only caching is lost.
 */

const KV_BINDING = 'PAN_INDEX_KV'

let kvUnavailable = false

async function getKV(): Promise<KVNamespace | null> {
  if (kvUnavailable) {
    return null
  }
  const kv = await resolveKV()
  if (!kv) {
    kvUnavailable = true
    console.warn(`KV namespace ${KV_BINDING} is not bound - caching is disabled. Bind it in your deployment settings.`)
    return null
  }
  return kv
}

async function resolveKV(): Promise<KVNamespace | null> {
  // OpenNext Cloudflare (Workers deployment)
  try {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare')
    return getCloudflareContext().env[KV_BINDING] ?? null
  } catch {
    // Not running inside OpenNext (e.g. plain next dev)
  }
  // Fallback: direct binding through process.env (legacy next-on-pages style)
  const env = process.env as unknown as { [key: string]: KVNamespace | undefined }
  return env[KV_BINDING] ?? null
}

export async function kvGetJson<T>(key: string): Promise<T | null> {
  const kv = await getKV()
  if (!kv) {
    return null
  }
  try {
    const value = await kv.get(key)
    if (value === null) {
      return null
    }
    return JSON.parse(value) as T
  } catch (error) {
    // Malformed entry or transient KV error, treat it as a cache miss
    console.warn(`KV read failed for ${key}:`, error)
    return null
  }
}

// ttl is in seconds and must be at least 60 (Cloudflare KV restriction)
export async function kvPutJson(key: string, value: unknown, ttl?: number): Promise<void> {
  const kv = await getKV()
  if (!kv) {
    return
  }
  try {
    const options = ttl && ttl >= 60 ? { expirationTtl: ttl } : undefined
    await kv.put(key, JSON.stringify(value), options)
  } catch (error) {
    console.warn(`KV write failed for ${key}:`, error)
  }
}

export async function kvDelete(key: string): Promise<void> {
  const kv = await getKV()
  if (!kv) {
    return
  }
  try {
    await kv.delete(key)
  } catch (error) {
    console.warn(`KV delete failed for ${key}:`, error)
  }
}
