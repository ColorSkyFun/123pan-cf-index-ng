import { kvGetJson } from '../../utils/kv'

export default async function handler(): Promise<Response> {
  return new Response(JSON.stringify(["probe4: OK", typeof kvGetJson]))
}
