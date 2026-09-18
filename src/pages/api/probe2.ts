import sha256 from 'crypto-js/sha256'

export default async function handler(): Promise<Response> {
  return new Response(JSON.stringify(["probe2: OK", typeof sha256]))
}
