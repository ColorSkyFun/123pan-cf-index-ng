import { NextRequest } from 'next/server'

import apiConfig from '../../../config/api.config'
import { checkAuthRoute, encodePath, panDownloadUrl, PanApiError, resolvePathId } from '../../utils/panClient'


export default async function handler(req: NextRequest): Promise<Response> {
  const { path = '/', odpt = '' } = Object.fromEntries(req.nextUrl.searchParams)

  // Sometimes the path parameter is defaulted to '[...path]' which we need to handle
  if (path === '[...path]') {
    return new Response(JSON.stringify({ error: 'No path specified.' }), { status: 400 })
  }
  // If the path is not a valid path, return 400
  if (typeof path !== 'string') {
    return new Response(JSON.stringify({ error: 'Path query invalid.' }), { status: 400 })
  }
  const cleanPath = encodePath(path)

  const headers: Record<string, string> = {
    'Cache-Control': apiConfig.cacheControlHeader,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  }

  try {
    // Handle protected routes authentication
    const odTokenHeader = req.headers.get('od-protected-token') ?? odpt
    const { code, message } = await checkAuthRoute(cleanPath, odTokenHeader)
    // Status code other than 200 means user has not authenticated yet
    if (code !== 200) {
      return new Response(JSON.stringify({ error: message }), { status: code })
    }

    // If message is empty, then the path is not protected.
    // Conversely, protected routes are not allowed to serve from cache.
    if (message !== '') {
      headers['Cache-Control'] = 'no-cache'
    }

    const downloadFor = async (bypassCache: boolean): Promise<string> => {
      const resolved = await resolvePathId(cleanPath, bypassCache)
      if (resolved.isFolder) {
        throw new PanApiError(404, 'No download url found.')
      }
      return panDownloadUrl({
        FileId: resolved.fileId,
        FileName: resolved.name,
        Size: resolved.size,
        Type: resolved.isFolder ? 1 : 0,
        Etag: resolved.etag,
        S3KeyFlag: resolved.s3KeyFlag,
      })
    }

    let downloadUrl: string
    try {
      downloadUrl = await downloadFor(false)
    } catch (error) {
      // The 123pan download API needs the file's etag/s3KeyFlag; a stale cache entry may miss
      // them, so re-resolve the path straight from the listing and try once more
      if (error instanceof PanApiError && error.code === 404) {
        throw error
      }
      downloadUrl = await downloadFor(true)
    }

    headers['Location'] = downloadUrl
    return new Response(null, { status: 302, headers })
  } catch (error: any) {
    if (error instanceof PanApiError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.code === 404 ? 404 : error.code === 401 ? 403 : 500,
        headers: { ...headers, 'Cache-Control': 'no-cache' },
      })
    }
    return new Response(JSON.stringify({ error: 'Internal server error.' }), { status: 500, headers })
  }
}
