import { NextRequest, NextResponse } from 'next/server'

import apiConfig from '../../../config/api.config'
import siteConfig from '../../../config/site.config'
import {
  getPathById,
  mimeForExtension,
  PanApiError,
  panListFolder,
  sitePathToHref,
  toSiteRelativePath,
} from '../../utils/panClient'

export const runtime = 'edge'

// The 123pan search is drive-wide, while the site only exposes baseDirectory: resolve each hit's
// real location and keep only the hits inside the shared folder.
function getNormalizedBase(): string {
  const base = (siteConfig.baseDirectory || '/').trim() || '/'
  return base === '/' ? '/' : '/' + base.replace(/^\/+|\/+$/g, '')
}

function isInsideBase(parentPath: string, normalizedBase: string): boolean {
  return normalizedBase === '/' || parentPath === normalizedBase || parentPath.startsWith(normalizedBase + '/')
}

export default async function handler(req: NextRequest): Promise<Response> {
  // Query parameter from request
  const { q: searchQuery = '' } = Object.fromEntries(req.nextUrl.searchParams)

  if (typeof searchQuery !== 'string' || searchQuery.trim() === '') {
    return NextResponse.json([])
  }

  const headers = {
    'Cache-Control': apiConfig.cacheControlHeader,
  }

  try {
    const normalizedBase = getNormalizedBase()
    const maxItems = Math.min(Math.max(siteConfig.maxItems, 1), 100)

    // Search through /file/list/new with SearchData set (a drive-wide match), then filter the
    // hits down to the shared folder. Parent lookups share a memo and are KV cached, so repeat
    // searches stay cheap; processed sequentially to respect the API's rate limits.
    const results: Record<string, any>[] = []
    const parentPaths = new Map<number, string | null>()
    let page = 1
    let exhausted = false

    while (results.length < maxItems && page <= 20 && !exhausted) {
      const { fileList, hasNextPage } = await panListFolder(0, page, searchQuery.trim())
      page += 1
      exhausted = !hasNextPage

      for (const hit of fileList) {
        const parentId = hit.ParentFileId ?? 0
        if (!parentPaths.has(parentId)) {
          parentPaths.set(parentId, parentId === 0 ? '/' : await getPathById(parentId))
        }
        const parentPath = parentPaths.get(parentId) ?? null

        // Keep only hits whose parent folder lives inside the shared folder
        if (parentPath === null || !isInsideBase(parentPath, normalizedBase)) {
          continue
        }

        // Provide the final site-relative path directly, so the frontend does not have to map
        // paths itself (the client bundle has no access to BASE_DIRECTORY)
        const parentRelative = toSiteRelativePath(parentPath)
        const parentHref = parentRelative === '' ? '' : sitePathToHref(parentRelative)
        const item: Record<string, any> = {
          id: String(hit.FileId),
          name: hit.FileName,
          path: `${parentHref}/${encodeURIComponent(hit.FileName)}`,
          parentReference: { id: String(parentId), path: `/drive/root:${parentPath === '/' ? '' : parentPath}` },
        }
        if (hit.Type === 1) {
          item.folder = {}
        } else {
          item.file = { mimeType: mimeForExtension(hit.FileName) }
        }
        results.push(item)

        if (results.length >= maxItems) {
          break
        }
      }
    }

    return NextResponse.json(results, { headers })
  } catch (error: any) {
    if (error instanceof PanApiError) {
      return new Response(JSON.stringify({ error: error.message }), { status: error.code === 401 ? 403 : 500 })
    }
    return new Response(JSON.stringify({ error: 'Internal server error.' }), { status: 500 })
  }
}
