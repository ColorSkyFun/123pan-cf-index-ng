import { NextRequest } from 'next/server'

import apiConfig from '../../../config/api.config'
import { checkAuthRoute, encodePath, panThumbnailUrl, PanApiError, resolvePathId } from '../../utils/panClient'

export const runtime = 'edge'

/**
 * 302s to a 123pan thumbnail rendition of the requested file. The web API derives thumbnails
 * from the listing item's download URL by rewriting its `_width_height` size suffix.
 */
export default async function handler(req: NextRequest): Promise<Response> {
  // Get item thumbnails by its path since we will later check if it is protected
  const { path = '', size = 'medium', odpt = '' } = Object.fromEntries(req.nextUrl.searchParams)

  // Check whether the size is valid - must be one of 'large', 'medium', or 'small'
  if (size !== 'large' && size !== 'medium' && size !== 'small') {
    return new Response(JSON.stringify({ error: 'Invalid size.' }), { status: 400 })
  }
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
  }

  try {
    const odTokenHeader = req.headers.get('od-protected-token') ?? odpt
    const { code, message } = await checkAuthRoute(cleanPath, odTokenHeader)
    if (code !== 200) {
      return new Response(JSON.stringify({ error: message }), { status: code })
    }

    const resolved = await resolvePathId(cleanPath)
    if (resolved.isFolder || !resolved.downloadUrl) {
      return new Response(JSON.stringify({ error: "The item doesn't have a valid thumbnail." }), { status: 400 })
    }
    const thumbnailUrl = panThumbnailUrl({ DownloadUrl: resolved.downloadUrl, FileName: resolved.name }, size)
    if (!thumbnailUrl) {
      return new Response(JSON.stringify({ error: "The item doesn't have a valid thumbnail." }), { status: 400 })
    }
    headers['Location'] = thumbnailUrl
    return new Response(null, { status: 302, headers })
  } catch (error: any) {
    if (error instanceof PanApiError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.code === 404 ? 404 : 500,
        headers: { ...headers, 'Cache-Control': 'no-cache' },
      })
    }
    return new Response(JSON.stringify({ error: 'Internal server error.' }), { status: 500, headers })
  }
}
