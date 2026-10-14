FROM node:22-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN npm install -g bun && bun install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN bun run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
RUN npm install -g bun && bun install --frozen-lockfile --production && npm uninstall -g bun
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
USER node
CMD ["node", "dist/api/main.js"]
