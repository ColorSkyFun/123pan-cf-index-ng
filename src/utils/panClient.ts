import { posix as pathPosix } from 'path-browserify'

import apiConfig from '../../config/api.config'
import siteConfig from '../../config/site.config'
import { kvDelete, kvGetJson, kvPutJson } from './kv'
import { compareHashedToken } from './protectedRouteHandler'

/**
 * Minimal client for the 123pan **web** API (https://yun.123pan.com/b/api), ported from the
 * OpenList `123Pan` driver and adapted for edge/serverless deployments. This avoids the paid
 * Open Platform: authentication is a plain account login that yields a JWT used as Bearer token.
 *
 * Every request URL must carry a CRC32 signature query parameter (see signRequest below).
 *
 * - 123pan identifies files by numeric fileId, while this project is path based, so paths are
 *   resolved by walking the tree from the root folder, caching each segment in KV.
 * - API responses are mapped into the OneDrive-like shapes the original frontend expects.
 */

// Raw item of the web file/list/new endpoint. `type` 1 means folder, 0 means file.
export type PanFile = {
  FileId: number
  FileName: string
  Size: number
  Type: number
  Etag: string
  S3KeyFlag: string
  UpdateAt?: string
  ParentFileId?: number
  DownloadUrl?: string
  Category?: number
}

export type PanPathInfo = {
  fileId: number
  isFolder: boolean
  name: string
  // Raw fields kept around for the download API, which requires the full file record
  etag?: string
  s3KeyFlag?: string
  size?: number
  downloadUrl?: string
}

export class PanApiError extends Error {
  code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

const PATH_CACHE_TTL = 3600
const TOKEN_KV_KEY = 'access_token'

// Per-isolate memo for the access token to spare KV reads
let memToken: { token: string; mode: 'login' | 'passport' } | null = null

/**
 * Encode the path of the file relative to the base directory
 *
 * @param path Relative path of the file to the base directory
 * @returns Normalised absolute path of the file inside the shared folder
 */
export function encodePath(path: string): string {
  return pathPosix.resolve('/', pathPosix.normalize(path)).replace(/\/$/, '')
}

// ---------------------------------------------------------------------------
// URL signature, a port of the OpenList driver's signPath(): every request URL
// gets a `<timeSign>=<timestamp>-<random>-<dataSign>` query parameter appended.
// ---------------------------------------------------------------------------

const SIGN_TABLE = 'adefghlmyijnopkqrstubcvwsz'

let crcTable: Uint32Array | null = null
function crc32(input: string): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      }
      crcTable[n] = c
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < input.length; i++) {
    crc = crcTable[(crc ^ input.charCodeAt(i)) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function signRequest(path: string): string {
  const random = String(Math.round(Math.random() * 1e7))
  const timestamp = String(Math.floor(Date.now() / 1000))
  // 123pan signs the current time formatted as yyyyMMddHHmm in UTC+8, digit-by-digit mapped
  const cst = new Date(Date.now() + 8 * 3600 * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  const nowStr = `${cst.getUTCFullYear()}${pad(cst.getUTCMonth() + 1)}${pad(cst.getUTCDate())}${pad(cst.getUTCHours())}${pad(cst.getUTCMinutes())}`
  let mapped = ''
  for (const ch of nowStr) {
    mapped += SIGN_TABLE[Number(ch)]
  }
  const timeSign = String(crc32(mapped))
  const data = [timestamp, random, path, apiConfig.platform, apiConfig.appVersion, timeSign].join('|')
  const dataSign = String(crc32(data))
  return `${timeSign}=${timestamp}-${random}-${dataSign}`
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * Fetch the 123pan Bearer token. A pasted PAN_PASSPORT_TOKEN is used as-is; otherwise the
 * account credentials are used to sign in (cached in KV until the API replies with 401).
 */
export async function getPanAccessToken(force = false): Promise<string> {
  if (apiConfig.passportToken) {
    return apiConfig.passportToken
  }
  if (!force && memToken) {
    return memToken.token
  }
  if (!force) {
    const cached = await kvGetJson<{ token: string; mode: 'login' | 'passport' }>(TOKEN_KV_KEY)
    if (cached) {
      memToken = cached
      return cached.token
    }
  }
  const token = await panLogin()
  memToken = { token, mode: 'login' }
  await kvPutJson(TOKEN_KV_KEY, memToken)
  console.log('Signed in to 123pan and cached the token.')
  return token
}

async function panLogin(): Promise<string> {
  const { username, password } = apiConfig
  if (!username || !password) {
    throw new PanApiError(401, 'No access token. Set PAN_USERNAME / PAN_PASSWORD or PAN_PASSPORT_TOKEN.')
  }
  const isEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(username)
  const body = isEmail ? { mail: username, password, type: 2 } : { passport: username, password, remember: true }

  const resp = await fetch(apiConfig.loginApi, {
    method: 'POST',
    headers: {
      origin: 'https://yun.123pan.com',
      referer: 'https://yun.123pan.com/',
      // Same user-agent the OpenList driver uses for sign-in
      'user-agent': 'Dart/2.19(dart:io)-openlist',
      platform: apiConfig.platform,
      'app-version': apiConfig.appVersion,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const data: { code?: number; message?: string; data?: { token?: string } } = await resp.json().catch(() => ({}))
  // The login endpoint answers with code 200 (some deployments 0) on success
  if ((data.code !== 200 && data.code !== 0) || !data.data?.token) {
    throw new PanApiError(401, `123pan login failed: ${data.message ?? 'unknown error'}. Check PAN_USERNAME / PAN_PASSWORD.`)
  }
  return data.data.token
}

async function invalidateToken(): Promise<void> {
  memToken = null
  await kvDelete(TOKEN_KV_KEY)
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

type PanRequestInit = {
  method?: 'GET' | 'POST'
  params?: Record<string, string | number | boolean | undefined>
  body?: unknown
}

/**
 * Perform a request against the 123pan web API. Success responses carry {code: 0, data}; a body
 * code of 401 means the token expired, which triggers one re-login and retry.
 */
export async function panRequest<T = any>(path: string, init: PanRequestInit = {}, retries = 1): Promise<T> {
  const { method = 'GET', params, body } = init
  const token = await getPanAccessToken()

  // The signature covers the full URL path, including the base endpoint's path prefix
  const fullPath = new URL(apiConfig.apiBase).pathname.replace(/\/$/, '') + path
  const searchParams = new URLSearchParams()
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) searchParams.append(key, String(value))
  }
  searchParams.append(...(signRequest(fullPath).split('=') as [string, string]))
  const query = searchParams.toString()

  const resp = await fetch(`${apiConfig.apiBase}${path}?${query}`, {
    method,
    headers: {
      origin: 'https://yun.123pan.com',
      referer: 'https://yun.123pan.com/',
      authorization: `Bearer ${token}`,
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) openlist-client',
      platform: apiConfig.platform,
      'app-version': apiConfig.appVersion,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

  const data: { code?: number; message?: string; data?: T } = await resp.json().catch(() => ({}))

  if (data.code === 0) {
    return data.data as T
  }
  if (data.code === 401 && retries > 0 && !apiConfig.passportToken) {
    // Token expired: sign in again and retry once. A pasted passport token cannot be refreshed.
    await invalidateToken()
    return panRequest<T>(path, init, retries - 1)
  }
  if (data.code === 401) {
    throw new PanApiError(401, apiConfig.passportToken ? 'The PAN_PASSPORT_TOKEN has expired, please paste a fresh one.' : '123pan authentication failed.')
  }
  throw new PanApiError(data.code ?? resp.status, data.message ?? `Request to ${path} failed.`)
}

// ---------------------------------------------------------------------------
// Core API operations
// ---------------------------------------------------------------------------

const listQueryDefaults = {
  driveId: 0,
  limit: 100,
  orderBy: 'file_name',
  orderDirection: 'asc',
  trashed: false,
  OnlyLookAbnormalFile: 0,
  event: 'homeListFile',
  operateType: 4,
  inDirectSpace: false,
}

/**
 * List the direct children of a folder through /file/list/new. Pagination is page-number based:
 * the response's `next` field is the last fileId of the page, or the string "-1" when exhausted.
 * Setting searchData performs a drive-wide search instead (the parent folder is ignored).
 */
export async function panListFolder(parentFileId: number, page = 1, searchData = ''): Promise<{ fileList: PanFile[]; hasNextPage: boolean }> {
  const data = await panRequest<{ InfoList?: PanFile[]; Total?: number; next?: string }>('/file/list/new', {
    params: {
      ...listQueryDefaults,
      parentFileId,
      next: '0',
      Page: page,
      SearchData: searchData,
    },
  })
  const fileList = (data.InfoList ?? []).filter(item => item.FileId !== undefined)
  // The real API keeps returning a pagination cursor even on the last page (instead of the
  // documented "-1"), so only trust it when the page came back completely full
  return { fileList, hasNextPage: data.next !== '-1' && fileList.length >= 100 }
}

/**
 * Fetch file metadata in bulk through /file/info (field casing in the response varies, so read
 * every variant).
 */
export async function panFileDetail(fileId: number): Promise<PanFile | null> {
  const data = await panRequest<any>('/file/info', {
    method: 'POST',
    body: { fileIdList: [{ fileId: String(fileId) }] },
  })
  const info = data?.infoList?.[0] ?? data?.InfoList?.[0]
  if (!info) {
    return null
  }
  return {
    FileId: Number(info.FileId ?? info.FileID ?? info.fileId ?? fileId),
    FileName: info.Name ?? info.FileName ?? info.fileName ?? '',
    Size: Number(info.Size ?? info.size ?? 0),
    Type: Number(info.Type ?? info.type ?? 0),
    Etag: info.Etag ?? info.etag ?? '',
    S3KeyFlag: info.S3KeyFlag ?? info.s3KeyFlag ?? '',
    ParentFileId: info.ParentFileId ?? info.ParentFileID ?? info.parentFileId,
    UpdateAt: info.UpdateAt ?? info.updateAt,
  }
}

/**
 * Resolve a file's download URL through /file/download_info, mirroring the OpenList driver:
 * the returned URL may wrap the real one in a `params` base64 query and respond with another
 * redirect or a JSON body carrying redirect_url.
 */
export async function panDownloadUrl(item: {
  FileId: number
  FileName: string
  Size?: number
  Type: number
  Etag?: string
  S3KeyFlag?: string
}): Promise<string> {
  const data = await panRequest<any>('/file/download_info', {
    method: 'POST',
    body: {
      driveId: 0,
      etag: item.Etag ?? '',
      fileId: item.FileId,
      fileName: item.FileName,
      s3keyFlag: item.S3KeyFlag ?? '',
      size: item.Size ?? 0,
      type: item.Type ?? 0,
    },
  })
  let url: string = data?.DownloadUrl ?? data?.downloadUrl ?? ''
  if (!url) {
    throw new PanApiError(404, 'No download url found.')
  }
  url = unwrapParamsUrl(url)
  try {
    // The download URL may itself redirect to the final CDN address
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { referer: 'https://yun.123pan.com/' },
    })
    if (res.status === 302 || res.status === 301) {
      const location = res.headers.get('location')
      if (location) {
        return location
      }
    } else if (res.status < 300) {
      const body: { data?: { redirect_url?: string } } = await res.json().catch(() => ({}))
      if (body.data?.redirect_url) {
        return body.data.redirect_url
      }
    }
  } catch {
    // Fall back to the pre-redirect URL below
  }
  return url
}

function unwrapParamsUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const wrapped = parsed.searchParams.get('params')
    if (wrapped) {
      // The inner URL was base64(encodeURI(...)); '+' may have been decoded to ' '
      const decoded = atob(wrapped.replace(/ /g, '+'))
      return decodeURIComponent(decoded)
    }
  } catch {
    // Not a wrapped URL
  }
  return url
}

const THUMBNAIL_SIZES: Record<string, number> = { small: 70, medium: 240, large: 480 }

/**
 * Derive a thumbnail URL from a listing item's DownloadUrl, following the OpenList Thumb()
 * approach: strip an existing `_width_height` suffix of the URL path (if any) and append the
 * requested one, plus the size query parameters. Returns an empty string without a usable URL.
 */
export function panThumbnailUrl(item: Pick<PanFile, 'DownloadUrl' | 'FileName'>, size: keyof typeof THUMBNAIL_SIZES | number = 'medium'): string {
  if (!item.DownloadUrl) {
    return ''
  }
  const dimension = typeof size === 'number' ? size : THUMBNAIL_SIZES[size] ?? 240
  try {
    const url = new URL(unwrapParamsUrl(item.DownloadUrl))
    url.pathname = url.pathname.replace(/_(\d+)_(\d+)$/, '') + `_${dimension}_${dimension}`
    url.searchParams.set('w', String(dimension))
    url.searchParams.set('h', String(dimension))
    if (!url.searchParams.has('type')) {
      const extension = item.FileName.includes('.') ? item.FileName.split('.').pop() ?? '' : ''
      if (extension) {
        url.searchParams.set('type', extension)
      }
    }
    if (!url.searchParams.has('trade_key')) {
      url.searchParams.set('trade_key', '123pan-thumbnail')
    }
    return url.toString()
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const pathSegments = (path: string): string[] => path.split('/').filter(Boolean)

/**
 * Convert a drive-absolute path into a site-relative path (relative to the shared base
 * directory). Returns the input unchanged when it lies outside the shared folder.
 */
export function toSiteRelativePath(absolutePath: string): string {
  const base = (siteConfig.baseDirectory || '/').trim() || '/'
  if (base === '/') {
    return absolutePath === '/' ? '' : absolutePath
  }
  const normalized = '/' + base.replace(/^\/+|\/+$/g, '')
  if (absolutePath === normalized) {
    return ''
  }
  if (absolutePath.startsWith(normalized + '/')) {
    return absolutePath.slice(normalized.length)
  }
  return absolutePath
}

/** Turn a site-relative path into a URL href with encoded segments ('' -> '/'). */
export function sitePathToHref(relativePath: string): string {
  return '/' + relativePath.split('/').filter(Boolean).map(encodeURIComponent).join('/')
}

/**
 * Resolve the shared base directory (siteConfig.baseDirectory) to its folder ID, honouring the
 * PAN_ROOT_FOLDER_ID environment override, and cache the mapping in KV.
 */
async function getRootFolderId(bypassCache = false): Promise<number> {
  const override = parseInt(process.env.PAN_ROOT_FOLDER_ID ?? '', 10)
  if (!Number.isNaN(override)) {
    return override
  }
  const base = (siteConfig.baseDirectory || '/').trim() || '/'
  if (base === '/') {
    return 0
  }
  const key = `root:${base}`
  if (!bypassCache) {
    const cached = await kvGetJson<number>(key)
    if (cached !== null) {
      return cached
    }
  }
  const resolved = await walkPath(0, pathSegments(base), bypassCache, '0')
  await kvPutJson(key, resolved.fileId, 86400)
  return resolved.fileId
}

/**
 * Walk a list of path segments downwards from startId, looking up each child by name and caching
 * the resolved ID of every visited prefix in KV.
 */
async function walkPath(startId: number, segments: string[], bypassCache: boolean, keyRoot: string): Promise<PanPathInfo> {
  let parentId = startId
  let acc = ''
  let info: PanPathInfo = { fileId: startId, isFolder: true, name: '' }
  for (const segment of segments) {
    acc = acc ? `${acc}/${segment}` : segment
    const key = `p:${keyRoot}:${acc}`
    let entry: PanPathInfo | null = bypassCache ? null : await kvGetJson<PanPathInfo>(key)
    if (!entry) {
      entry = await findChildByName(parentId, segment)
      await kvPutJson(key, entry, PATH_CACHE_TTL)
    }
    parentId = entry.fileId
    info = entry
  }
  return info
}

/** Find a direct child of parentId by its exact name, paging through the folder listing. */
async function findChildByName(parentId: number, name: string): Promise<PanPathInfo> {
  for (let page = 1; page <= 50; page++) {
    const { fileList, hasNextPage } = await panListFolder(parentId, page)
    const hit = fileList.find(item => item.FileName === name)
    if (hit) {
      return {
        fileId: hit.FileId,
        isFolder: hit.Type === 1,
        name: hit.FileName,
        etag: hit.Etag,
        s3KeyFlag: hit.S3KeyFlag,
        size: hit.Size,
        downloadUrl: hit.DownloadUrl,
      }
    }
    if (!hasNextPage) {
      break
    }
  }
  throw new PanApiError(404, `Path not found: ${name}`)
}

/**
 * Resolve a user-facing path (relative to the shared base directory) into a 123pan fileId.
 * Cached resolutions are re-walked once without cache when they turn out stale.
 */
export async function resolvePathId(cleanPath: string, bypassCache = false): Promise<PanPathInfo> {
  const segments = pathSegments(cleanPath)
  if (segments.length === 0) {
    return { fileId: await getRootFolderId(bypassCache), isFolder: true, name: '' }
  }
  try {
    const rootId = await getRootFolderId(bypassCache)
    return await walkPath(rootId, segments, bypassCache, String(rootId))
  } catch (error) {
    if (bypassCache) {
      throw error
    }
    // Either the cached root or a cached segment is stale (folder renamed/moved/deleted):
    // re-resolve the whole chain straight from the drive root, refreshing caches on the way.
    console.log('Path resolution failed, re-resolving without cache:', error)
    const rootId = await getRootFolderId(true)
    return await walkPath(rootId, segments, true, String(rootId))
  }
}

type PanItemInfo = { name: string; parentId: number | null; isFolder: boolean }

async function getItemInfo(fileId: number): Promise<PanItemInfo | null> {
  const key = `i:${fileId}`
  const cached = await kvGetJson<PanItemInfo>(key)
  if (cached) {
    return cached
  }
  const detail = await panFileDetail(fileId)
  if (!detail) {
    return null
  }
  const info: PanItemInfo = {
    name: detail.FileName,
    parentId: detail.ParentFileId ?? null,
    isFolder: detail.Type === 1,
  }
  await kvPutJson(key, info, PATH_CACHE_TTL)
  return info
}

/**
 * Resolve the absolute path of an item under the 123pan drive root by walking up its parents,
 * e.g. '/Docs/a.txt'. Returns null when the chain cannot be resolved.
 */
export async function getPathById(fileId: number): Promise<string | null> {
  const parts: string[] = []
  let current: number | null = fileId
  for (let depth = 0; depth < 64 && current !== null && current !== 0; depth++) {
    const info = await getItemInfo(current)
    if (!info || info.parentId === null) {
      return null
    }
    parts.unshift(info.name)
    current = info.parentId
  }
  return '/' + parts.join('/')
}

/**
 * Convert a 123pan timestamp into an ISO string. Timezone-aware values (RFC3339) are parsed
 * as-is; naive values ("YYYY-MM-DD HH:mm:ss") are treated as UTC+8, the web client's timezone.
 */
export function panTimeToIso(value?: string): string {
  if (value) {
    if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(value)) {
      const parsed = Date.parse(value)
      if (!Number.isNaN(parsed)) {
        return new Date(parsed).toISOString()
      }
    }
    const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value)
    if (match) {
      const utcMs = Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]) - 8 * 3600 * 1000
      return new Date(utcMs).toISOString()
    }
    const fallback = Date.parse(value)
    if (!Number.isNaN(fallback)) {
      return new Date(fallback).toISOString()
    }
  }
  return new Date().toISOString()
}

const mimeTypes: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.wmv': 'video/x-ms-wmv',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.opus': 'audio/opus',
  '.pdf': 'application/pdf',
  '.epub': 'application/epub+zip',
  '.mobi': 'application/x-mobipocket-ebook',
  '.azw3': 'application/vnd.amazon.ebook',
  '.zip': 'application/zip',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

export function mimeForExtension(filename: string): string {
  const extension = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')).toLowerCase() : ''
  return mimeTypes[extension] ?? 'application/octet-stream'
}

/**
 * Map a 123pan item into the OneDrive-like driveItem shape consumed by the frontend. Only fields
 * the frontend actually reads are populated: name/size/id/lastModifiedDateTime, folder/file
 * markers, and the derived thumbnail URL for files.
 */
export function panToDriveItem(item: PanFile, withThumbnail = true): Record<string, any> {
  const mapped: Record<string, any> = {
    id: String(item.FileId),
    name: item.FileName,
    size: item.Size,
    lastModifiedDateTime: panTimeToIso(item.UpdateAt),
  }
  if (item.Type === 1) {
    mapped.folder = {}
  } else {
    mapped.file = { mimeType: mimeForExtension(item.FileName), hashes: {} }
    if (withThumbnail && item.DownloadUrl) {
      const thumbnail = panThumbnailUrl(item, 'medium')
      if (thumbnail) {
        mapped.thumbnail = thumbnail
      }
    }
  }
  return mapped
}

/**
 * Match protected routes in site config to get path to required auth token
 * @param path Path cleaned in advance
 * @returns Path to required auth token. If not required, return empty string.
 */
export function getAuthTokenPath(path: string): string {
  // Ensure trailing slashes to compare paths component by component. Since paths ignore case,
  // lower case before comparing. Same for protectedRoutes.
  path = path.toLowerCase() + '/'
  const protectedRoutes = siteConfig.protectedRoutes as string[]
  let authTokenPath = ''
  for (let r of protectedRoutes) {
    if (typeof r !== 'string') continue
    r = r.toLowerCase().replace(/\/$/, '') + '/'
    if (path.startsWith(r)) {
      authTokenPath = `${r}.password`
      break
    }
  }
  return authTokenPath
}

/**
 * Handles protected route authentication by comparing the hashed request token with the contents
 * of the .password file inside the protected route.
 *
 * @param cleanPath Sanitised directory path, used for matching whether route is protected
 * @param odTokenHeader Hashed token carried by the request
 */
export async function checkAuthRoute(cleanPath: string, odTokenHeader: string): Promise<{ code: 200 | 401 | 404 | 500; message: string }> {
  const authTokenPath = getAuthTokenPath(cleanPath)

  if (authTokenPath === '') {
    return { code: 200, message: '' }
  }

  try {
    const resolved = await resolvePathId(authTokenPath)
    const downloadUrl = await panDownloadUrl({
      FileId: resolved.fileId,
      FileName: resolved.name,
      Size: resolved.size,
      Type: resolved.isFolder ? 1 : 0,
      Etag: resolved.etag,
      S3KeyFlag: resolved.s3KeyFlag,
    })
    const content = await (await fetch(downloadUrl)).text()

    if (!compareHashedToken({ odTokenHeader, dotPassword: content.toString() })) {
      return { code: 401, message: 'Password required.' }
    }
  } catch (error: any) {
    // Password file not found, fallback to 404
    if (error instanceof PanApiError && error.code === 404) {
      return { code: 404, message: "You didn't set a password." }
    }
    return { code: 500, message: 'Internal server error.' }
  }

  return { code: 200, message: 'Authenticated.' }
}
