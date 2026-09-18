import { default as rawFileHandler } from '../raw'
import { NextRequest } from 'next/server'


export default async function handler(req: NextRequest): Promise<Response> {
  return rawFileHandler(req)
}
