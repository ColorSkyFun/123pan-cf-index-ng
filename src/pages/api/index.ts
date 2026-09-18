import { NextRequest, NextResponse } from 'next/server'

import apiConfig from '../../../config/api.config'
import {
  checkAuthRoute,
  encodePath,
  panFileDetail,
  PanApiError,
  panListFolder,
  panToDriveItem,
  resolvePathId,
} from '../../utils/panClient'


/**
 * Sort drive items the way a file index expects: folders first, then files, both by name
 * (natural sort). The 123pan list API does not support server-side ordering.
 */
function sortDriveItems(items: Record<string, any>[]): Record<string, any>[] {
  return [...items].sort((a, b) => {
    const aFolder = 'folder' in a
    const bFolder = 'folder' in b
    if (aFolder !== bFolder) {
      return aFolder ? -1 : 1
    }
    return a.name.localeCompare(b.name, undefined, { numeric: true })
  })
}

export default async function handler(req: NextRequest): Promise<Response> {
  const { path = '/', next = '' } = Object.fromEntries(req.nextUrl.searchParams)

  // Sometimes the path parameter is defaulted to '[...path]' which we need to handle
  if (path === '[...path]') {
    return new Response(JSON.stringify({ error: 'No path specified.' }), { status: 400 })
  }
  // If the path is not a valid path, return 400
  if (typeof path !== 'string') {
    return new Response(JSON.stringify({ error: 'Path query invalid.' }), { status: 400 })
  }
  // Besides normalizing and making absolute, trailing slashes are trimmed
  const cleanPath = encodePath(path)

  const headers = {
    'Cache-Control': apiConfig.cacheControlHeader,
  }

  try {
    // Handle protected routes authentication
    const odTokenHeader = req.headers.get('od-protected-token') ?? ''
    const { code, message } = await checkAuthRoute(cleanPath, odTokenHeader)
    // Status code other than 200 means user has not authenticated yet
    if (code !== 200) {
      return new Response(JSON.stringify({ error: message }), { status: code })
    }

    const { fileId, isFolder } = await resolvePathId(cleanPath)

    if (!isFolder) {
      const item = await panFileDetail(fileId)
      if (!item) {
        return new Response(JSON.stringify({ error: 'File not found.' }), { status: 404, headers })
      }
      return NextResponse.json({ file: panToDriveItem(item) }, { headers })
    }

    // List children; pagination uses the page number as the cursor
    const parsedNext = parseInt(next, 10)
    const page = Number.isNaN(parsedNext) ? 1 : Math.max(parsedNext, 1)
    const { fileList, hasNextPage } = await panListFolder(fileId, page)

    const response: { folder: Record<string, any>; next?: string } = {
      folder: {
        value: sortDriveItems(fileList.map(item => panToDriveItem(item))),
      },
    }
    if (hasNextPage) {
      response.next = String(page + 1)
    }

    return NextResponse.json(response, { headers })
  } catch (error: any) {
    if (error instanceof PanApiError) {
      // Map the 123pan authentication failure to 403 like the OneDrive version did
      const status = error.code === 404 ? 404 : error.code === 401 ? 403 : 500
      return new Response(JSON.stringify({ error: error.message }), { status, headers: { 'Cache-Control': 'no-cache' } })
    }
    return new Response(JSON.stringify({ error: 'Internal server error.' }), { status: 500 })
  }
}
