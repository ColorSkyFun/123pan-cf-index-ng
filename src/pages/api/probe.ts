// TEMP DEBUG probe: dynamically import each suspect module and report which one throws
async function tryImport(name: string, loader: () => Promise<any>): Promise<string> {
  try {
    await loader()
    return `${name}: OK`
  } catch (error: any) {
    return `${name}: THROW ${error?.name}: ${error?.message}`
  }
}

export default async function handler(): Promise<Response> {
  const results: string[] = []
  results.push(await tryImport('path-browserify', () => import('path-browserify')))
  results.push(await tryImport('crypto-js-sha256', () => import('crypto-js/sha256')))
  results.push(await tryImport('api.config', () => import('../../../config/api.config')))
  results.push(await tryImport('kv', () => import('../../utils/kv')))
  results.push(await tryImport('protectedRouteHandler', () => import('../../utils/protectedRouteHandler')))
  results.push(await tryImport('panClient', () => import('../../utils/panClient')))
  return new Response(JSON.stringify(results, null, 1), {
    headers: { 'content-type': 'application/json', 'Cache-Control': 'no-cache' },
  })
}
