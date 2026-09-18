import { posix as pathPosix } from 'path-browserify'

import apiConfig from '../../../config/api.config'
import siteConfig from '../../../config/site.config'
import {
  checkAuthRoute,
  encodePath,
  mimeForExtension,
  PanApiError,
  panFileDetail,
  panListFolder,
  panToDriveItem,
  resolvePathId,
} from '../../utils/panClient'
import { NextRequest } from 'next/server'

export const runtime = 'edge'

const defaultExtensions = ['.epub', '.pdf', '.mobi', '.azw3', '.azw', '.cbz', '.cbr']
const extensionMimeTypes: Record<string, string> = {
  '.epub': 'application/epub+zip',
  '.pdf': 'application/pdf',
  '.mobi': 'application/x-mobipocket-ebook',
  '.azw': 'application/vnd.amazon.ebook',
  '.azw3': 'application/vnd.amazon.ebook',
  '.cbz': 'application/vnd.comicbook+zip',
  '.cbr': 'application/vnd.comicbook-rar',
}

type OpdsConfig = {
  enabled: boolean
  title: string
  description?: string
  fileExtensions: Set<string>
}

type DriveItem = {
  id: string
  name: string
  size: number
  lastModifiedDateTime: string
  file?: { mimeType?: string }
  folder?: { childCount?: number }
}

const getOpdsConfig = (): OpdsConfig => {
  const fallbackTitle = typeof siteConfig.title === 'string' ? siteConfig.title : 'OPDS Catalog'
  const rawOpds = (siteConfig.opds ?? {}) as Partial<{
    enabled: boolean
    title: string
    description: string
    fileExtensions: string[]
  }>
  const extensions = Array.isArray(rawOpds.fileExtensions) && rawOpds.fileExtensions.length > 0 ? rawOpds.fileExtensions : defaultExtensions
  const normalized = new Set(
    extensions.map((extension) => (extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`))
  )

  return {
    enabled: rawOpds.enabled !== false,
    title: typeof rawOpds.title === 'string' && rawOpds.title.trim() ? rawOpds.title.trim() : fallbackTitle,
    description: typeof rawOpds.description === 'string' ? rawOpds.description : undefined,
    fileExtensions: normalized,
  }
}

const escapeXml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

const buildUrl = (origin: string, pathname: string, params: Record<string, string | undefined>) => {
  const url = new URL(pathname, origin)
  Object.entries(params).forEach(([key, value]) => {
    if (value) url.searchParams.set(key, value)
  })
  return url.toString()
}

const buildLink = (attributes: Record<string, string | number | undefined>) => {
  const attrString = Object.entries(attributes)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}="${escapeXml(String(value))}"`)
    .join(' ')
  return `<link ${attrString} />`
}

const buildEntry = (entry: {
  title: string
  id: string
  updated: string
  links: Array<Record<string, string | number | undefined>>
  summary?: string
}) => {
  const summaryXml = entry.summary ? `<summary type="text">${escapeXml(entry.summary)}</summary>` : ''
  return [
    '<entry>',
    `<title>${escapeXml(entry.title)}</title>`,
    `<id>${escapeXml(entry.id)}</id>`,
    `<updated>${escapeXml(entry.updated)}</updated>`,
    entry.links.map(buildLink).join(''),
    summaryXml,
    '</entry>',
  ].join('')
}

const toUpdated = (value?: string) => {
  const date = value ? new Date(value) : new Date()
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

const normalizePathParam = (pathParam: string) => pathPosix.resolve('/', pathPosix.normalize(pathParam)).replace(/\/$/, '')

const isEligibleFile = (fileName: string, allowedExtensions: Set<string>) => {
  const extension = pathPosix.extname(fileName).toLowerCase()
  return allowedExtensions.has(extension)
}

const buildWebUrl = (origin: string, rawPath: string) => {
  const url = new URL(origin)
  url.pathname = rawPath
  return url.toString()
}

export default async function handler(req: NextRequest): Promise<Response> {
  const opdsConfig = getOpdsConfig()
  if (!opdsConfig.enabled) {
    return new Response('OPDS is disabled.', { status: 404 })
  }

  const { path = '/', next = '', odpt = '' } = Object.fromEntries(req.nextUrl.searchParams)
  if (path === '[...path]') {
    return new Response(JSON.stringify({ error: 'No path specified.' }), { status: 400 })
  }
  if (typeof path !== 'string') {
    return new Response(JSON.stringify({ error: 'Path query invalid.' }), { status: 400 })
  }

  const cleanPath = normalizePathParam(path)
  const normalizedPath = cleanPath || '/'
  const odTokenHeader = (req.headers.get('od-protected-token') as string) ?? odpt

  const responseHeaders: Record<string, string> = {
    'Content-Type': 'application/atom+xml;profile=opds-catalog;charset=utf-8',
  }

  try {
    const { code, message } = await checkAuthRoute(cleanPath, odTokenHeader)
    if (code !== 200) {
      return new Response(JSON.stringify({ error: message }), { status: code })
    }

    const { fileId, isFolder } = await resolvePathId(cleanPath)

    let items: DriveItem[] = []
    let nextPage: string | null = null
    let selfUpdated = new Date().toISOString()

    if (isFolder) {
      const parsedNext = parseInt(next, 10)
      const page = Number.isNaN(parsedNext) ? 1 : Math.max(parsedNext, 1)
      const { fileList, hasNextPage } = await panListFolder(fileId, page)
      items = fileList.map((item) => panToDriveItem(item) as DriveItem)
      if (hasNextPage) {
        nextPage = String(page + 1)
      }
    } else {
      const item = await panFileDetail(fileId)
      if (!item) {
        return new Response(JSON.stringify({ error: 'File not found.' }), { status: 404 })
      }
      const mapped = panToDriveItem(item) as DriveItem
      items = [mapped]
      selfUpdated = mapped.lastModifiedDateTime
    }

    responseHeaders['Cache-Control'] = nextPage ? 'no-cache' : apiConfig.cacheControlHeader

    const origin = req.nextUrl.origin
    const isRootPath = normalizedPath === '/'
    const baseParams = !isRootPath ? { path: cleanPath } : {}
    const selfUrl = buildUrl(origin, '/api/opds', { ...baseParams, ...(next ? { next } : {}) })
    const startUrl = buildUrl(origin, '/api/opds', {})
    const currentWebUrl = buildWebUrl(origin, normalizedPath)

    const links = [
      buildLink({ rel: 'self', href: selfUrl, type: 'application/atom+xml;profile=opds-catalog' }),
      buildLink({ rel: 'start', href: startUrl, type: 'application/atom+xml;profile=opds-catalog' }),
      buildLink({ rel: 'alternate', href: currentWebUrl, type: 'text/html' }),
    ]

    if (!isRootPath) {
      const parentPath = pathPosix.dirname(normalizedPath)
      links.push(
        buildLink({
          rel: 'up',
          href: buildUrl(origin, '/api/opds', parentPath !== '/' ? { path: parentPath } : {}),
          type: 'application/atom+xml;profile=opds-catalog',
        })
      )
    }

    if (nextPage) {
      links.push(
        buildLink({
          rel: 'next',
          href: buildUrl(origin, '/api/opds', { ...baseParams, next: nextPage }),
          type: 'application/atom+xml;profile=opds-catalog',
        })
      )
    }

    const entries = items
      .filter((item) => item.folder || isEligibleFile(item.name, opdsConfig.fileExtensions))
      .map((item) => {
        const itemPath = pathPosix.join(normalizedPath, item.name)
        const entryId = buildWebUrl(origin, itemPath)
        const entryUpdated = toUpdated(item.lastModifiedDateTime)
        if (item.folder) {
          return buildEntry({
            title: item.name,
            id: entryId,
            updated: entryUpdated,
            summary: 'Folder',
            links: [
              {
                rel: 'subsection',
                href: buildUrl(origin, '/api/opds', { path: itemPath }),
                type: 'application/atom+xml;profile=opds-catalog;kind=navigation',
              },
              { rel: 'alternate', href: buildWebUrl(origin, itemPath), type: 'text/html' },
            ],
          })
        }

        const extension = pathPosix.extname(item.name).toLowerCase()
        const mimeType = item.file?.mimeType ?? extensionMimeTypes[extension] ?? mimeForExtension(item.name)
        return buildEntry({
          title: item.name,
          id: entryId,
          updated: entryUpdated,
          summary: `File (${item.size} bytes)`,
          links: [
            {
              rel: 'http://opds-spec.org/acquisition',
              href: buildUrl(origin, '/api/raw', { path: itemPath }),
              type: mimeType,
              length: item.size,
            },
            { rel: 'alternate', href: buildWebUrl(origin, itemPath), type: 'text/html' },
          ],
        })
      })
      .join('')

    const subtitle = opdsConfig.description ? `<subtitle>${escapeXml(opdsConfig.description)}</subtitle>` : ''
    const author = typeof siteConfig.title === 'string' ? siteConfig.title : opdsConfig.title

    const feed = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">',
      `<id>${escapeXml(selfUrl)}</id>`,
      `<title>${escapeXml(opdsConfig.title)}</title>`,
      subtitle,
      `<updated>${escapeXml(selfUpdated)}</updated>`,
      `<author><name>${escapeXml(author)}</name></author>`,
      links.join(''),
      entries,
      '</feed>',
    ].join('')

    return new Response(feed, { status: 200, headers: responseHeaders })
  } catch (error: any) {
    if (error instanceof PanApiError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.code === 404 ? 404 : error.code === 401 ? 403 : 500,
      })
    }
    responseHeaders['Content-Type'] = 'application/json;charset=utf-8'
    return new Response(JSON.stringify({ error: 'Internal server error.' }), { status: 500, headers: responseHeaders })
  }
}
