FROM node:24-slim AS build

RUN npm install -g pnpm

COPY . /src
WORKDIR /src

RUN pnpm install
RUN npx opennextjs-cloudflare build

FROM node:24-slim AS runtime

COPY --from=build /src/.open-next /app/.open-next
COPY --from=build /src/scripts/docker-entrypoint.sh /app/docker-entrypoint.sh
WORKDIR /app
RUN npm install -g wrangler@4.76.0 \
    && chmod +x /app/docker-entrypoint.sh

EXPOSE 8788

CMD ["/app/docker-entrypoint.sh"]
