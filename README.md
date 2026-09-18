<div align="center">
  <img src="./public/header.png" alt="123pan-cf-index-ng" />
  <h3>123pan-cf-index-ng</h3>
  <p><em>123云盘 public directory listing forked from <a href="https://github.com/lyc8503/onedrive-cf-index-ng">onedrive-cf-index-ng</a>, powered by Cloudflare and Next.js</em></p>

  <img src="https://img.shields.io/badge/123%E4%BA%91%E7%9B%98-123pan-blue" alt="123pan" />
  <img src="https://img.shields.io/badge/Cloudflare-f38020?style=flat&logo=Cloudflare&logoColor=white" alt="Cloudflare" />
  <img src="https://img.shields.io/badge/Next.js-black?style=flat&logo=next.js&logoColor=white" alt="Next.js" />
</div>

## What's different from upstream

- 123pan (123云盘) is integrated through its **web client API**, following the approach of OpenList's `123Pan` driver. **No paid Open Platform developer access is required** - the server signs in with your account (or a pasted web-session token), and tokens are refreshed automatically.
- The 123pan API identifies files by `fileId`, so paths are resolved by walking the tree from the shared root, with per-segment caching in Cloudflare KV.
- File thumbnails in the grid layout are derived from the web API's download URLs (same trick OpenList uses).
- Every request URL carries a CRC32 signature parameter, exactly like the official web client.

*Special thanks to [@lyc8503](https://github.com/lyc8503) (onedrive-cf-index-ng), [@spencerwooo](https://github.com/spencerwooo) (onedrive-vercel-index) and the OpenList team - this project stands on their shoulders.*

## TL;DR

Showcase, share, preview, and download files inside *your* 123pan drive -

- Completely free to host 💸
- Super fast ⚡ and responsive 💦
- Highly customisable ⚒️

## Quick start

1. **Fork** this repository and push it to your own GitHub account.

2. **Create a Cloudflare Worker** connected to the repo (the current recommended way to run Next.js on Cloudflare):

   - Cloudflare Dashboard -> **Workers 和 Pages -> 创建 -> 导入仓库**, pick the fork
   - Framework preset: **Next.js** — Cloudflare auto-generates the build (`npx opennextjs-cloudflare build`) and deploy (`npx opennextjs-cloudflare deploy`) commands
   - Do **not** check in your own `wrangler.jsonc`; let Cloudflare generate it

3. **Configure environment variables** (Worker -> Settings -> Variables and Secrets, apply to Production and Preview):

   | Variable | Required | Description |
   | --- | --- | --- |
   | `PAN_USERNAME` | Yes* | 123pan account (phone number or e-mail) |
   | `PAN_PASSWORD` | Yes* | 123pan account password |
   | `PAN_PASSPORT_TOKEN` | No | Alternative to the account: paste the Bearer token of a logged-in web session (F12 -> Network -> copy the `authorization` header of any `yun.123pan.com` request). No auto-refresh - replace it when it expires. |
   | `BASE_DIRECTORY` | No | Folder to share, relative to your drive root (default `/`) |
   | `PAN_ROOT_FOLDER_ID` | No | Numeric folder ID to serve as root, skipping path resolution (visible in the 123pan web URL when you open the folder) |

   \* Account + password is recommended: the server re-authenticates automatically whenever the token expires. If 123pan's risk control blocks server-side logins for your account, fall back to `PAN_PASSPORT_TOKEN`.

4. **Bind a KV namespace** (Worker -> Settings -> Bindings -> KV namespace): variable name `PAN_INDEX_KV`. It caches the access token and path mappings.

5. Redeploy, customise [config/site.config.js](config/site.config.js) (title, footer, protected folders, ...) and enjoy!

### Docker

```bash
docker build -t 123pan-cf-index-ng .
docker run -p 8788:8788 \
  -e PAN_USERNAME=your_account \
  -e PAN_PASSWORD=your_password \
  123pan-cf-index-ng
```

The container serves the OpenNext bundle through `wrangler dev` with a local KV simulation bound as `PAN_INDEX_KV`, so no extra setup is needed for testing.

## Features

- List / grid layouts, pagination, README.md preview
- File thumbnails in the grid layout (derived from the 123pan web API)
- Preview for PDF, EPUB, markdown, code, plain text, Office documents
- Video and audio streaming (mp4 / flv / mp3 / ...), with `.vtt` subtitles
- Password protected folders (`.password` files, configured through `protectedRoutes`)
- Multi-file and folder download (zip on the fly)
- Global search (powered by the 123pan web API)
- OPDS catalog endpoint for ebook readers at `/api/opds?path=/`

## Notes

- This integration talks to the **web client API**, which is undocumented and can change without notice; request signing follows the current web client (see `signRequest` in [src/utils/panClient.ts](src/utils/panClient.ts)).
- Login attempts from datacenter IPs (e.g. Cloudflare) may occasionally be risk-controlled by 123pan; if password sign-in fails, use the `PAN_PASSPORT_TOKEN` variable instead.
- Search covers the whole drive (the API ignores the shared folder boundary); results outside your `baseDirectory` still open correctly.
- Sorting is emulated locally (folders first, natural name order).

> **Note**: This project is focused on showcasing and providing a way for others to download files from your drive. Emphasis on **free** and **serverless**. If you have your own server / need WebDAV / mount protocols, checkout [OpenList](https://github.com/OpenListTeam/OpenList).

## License

[MIT](LICENSE)

<div align="center">
  <img src="./public/footer.png" />
  <em>made with ❤️ by <a href="https://lyc8503.net">lyc8503</a> & <a href="https://spencerwoo.com">spencer woo</a></em>
</div>
