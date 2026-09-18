import { encodePath } from '../../utils/panClient'

export default async function handler(): Promise<Response> {
  return new Response(JSON.stringify(["probe6: OK", typeof encodePath]))
}
