FROM node:20-alpine

LABEL org.opencontainers.image.title="ssh4ai" \
      org.opencontainers.image.description="Self-hosted SSH terminal manager in your browser (SSH for AI)" \
      org.opencontainers.image.source="https://github.com/rosariosai/ssh4ai" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
EXPOSE 7722
USER node

# Healthy when the web server answers on its own port (127.0.0.1 is always an allowed Host).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7722)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
