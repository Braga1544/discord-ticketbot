FROM node:20-alpine
# ticket names in local time, alpine is utc otherwise
RUN apk add --no-cache tzdata
ENV TZ=Europe/Berlin
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
CMD ["node","index.js"]
