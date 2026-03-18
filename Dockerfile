FROM node:20-alpine

WORKDIR /app

# Increase Node memory for TypeScript compilation
ENV NODE_OPTIONS="--max-old-space-size=4096"

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Reset memory limit for runtime
ENV NODE_OPTIONS=""

EXPOSE 3000

CMD ["node", "dist/index.js"]
