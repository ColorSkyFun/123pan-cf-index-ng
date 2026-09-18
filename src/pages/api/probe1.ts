import pathPosix from 'path-browserify'

export default async function handler(): Promise<Response> {
  return new Response(JSON.stringify(["probe1: OK", typeof pathPosix]))
}
