# ollama-gw image. Build context is deploy/gateway only.
#   scripts/bots/bot.sh build
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
RUN useradd --uid 10002 --user-group --no-create-home --shell /usr/sbin/nologin gw
COPY gateway.mjs /gw/gateway.mjs
RUN chown -R root:root /gw && chmod -R a-w /gw
LABEL economy.role=gateway
USER 10002:10002
WORKDIR /gw
ENV NODE_ENV=production
EXPOSE 11434
CMD ["node", "/gw/gateway.mjs"]
