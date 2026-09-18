import { compareHashedToken } from '../../utils/protectedRouteHandler'

export default async function handler(): Promise<Response> {
  return new Response(JSON.stringify(["probe5: OK", typeof compareHashedToken]))
}
