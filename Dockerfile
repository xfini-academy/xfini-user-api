FROM node:26-alpine

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install --global pnpm@11.26.0 && pnpm install --frozen-lockfile --prod

COPY . .

EXPOSE 3001

CMD ["pnpm", "start"]
