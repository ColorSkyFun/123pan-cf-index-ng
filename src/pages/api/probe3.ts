import apiConfig from '../../../config/api.config'

export default async function handler(): Promise<Response> {
  return new Response(JSON.stringify(["probe3: OK", typeof apiConfig]))
}
