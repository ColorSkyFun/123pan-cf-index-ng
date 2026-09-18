import { NextRequest, NextResponse } from 'next/server'

import apiConfig from '../../../config/api.config'
import { PanApiError, panFileDetail, getPathById, sitePathToHref, toSiteRelativePath } from '../../utils/panClient'


export default async function handler(req: NextRequest): Promise<Response> {
  // Get item details (specifically, its path) by its unique ID on 123pan
  const { id = '' } = Object.fromEntries(req.nextUrl.searchParams)

  if (typeof id !== 'string' || !/^\d+$/.test(id)) {
    // ID contains characters other than digits
    return new Response(JSON.stringify({ error: 'Invalid driveItem ID.' }), { status: 400 })
  }

  const headers = {
    'Cache-Control': apiConfig.cacheControlHeader,
  }

  try {
    const fileId = parseInt(id, 10)
    const [item, absolutePath] = await Promise.all([panFileDetail(fileId), getPathById(fileId)])

    if (!item || !absolutePath) {
      return new Response(JSON.stringify({ error: 'Could not resolve the path of this item.' }), { status: 404, headers })
    }

    // Emulate the OneDrive parentReference shape consumed by the search modal, and provide the
    // parent's final site-relative path directly so the frontend does not have to map paths
    // itself (the client bundle has no access to BASE_DIRECTORY)
    const lastSlash = absolutePath.lastIndexOf('/')
    const parentPath = lastSlash <= 0 ? '/' : absolutePath.slice(0, lastSlash)
    const parentRelative = toSiteRelativePath(parentPath)
    return NextResponse.json(
      {
        id: String(item.FileId),
        name: item.FileName,
        path: parentRelative === '' ? '' : sitePathToHref(parentRelative),
        parentReference: {
          id: String(item.ParentFileId ?? 0),
          path: `/drive/root:${parentPath === '/' ? '' : parentPath}`,
        },
      },
      { headers }
    )
  } catch (error: any) {
    if (error instanceof PanApiError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.code === 404 ? 404 : 500,
        headers,
      })
    }
    return new Response(JSON.stringify({ error: 'Internal server error.' }), { status: 500, headers })
  }
}
