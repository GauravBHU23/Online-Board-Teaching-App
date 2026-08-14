# Portable image — works on Fly.io, Railway, Cloud Run, or any Docker host.
FROM node:22-alpine

# Install dependencies first so this layer is cached across code changes.
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

# Boards live on a mounted volume; the default keeps the image self-contained.
ENV NODE_ENV=production \
    DATA_DIR=/var/data \
    PORT=3000
RUN mkdir -p /var/data && chown -R node:node /var/data

# Drop root — the app never needs it.
USER node
EXPOSE 3000

# The health endpoint stays outside the auth gate so probes work with a
# password set.
HEALTHCHECK --interval=30s --timeout=4s --start-period=8s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
