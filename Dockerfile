FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
ENV HOST=0.0.0.0
ENV PORT=3100
USER node
EXPOSE 3100
CMD ["npm", "start"]
