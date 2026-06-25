FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache \
    git \
    python3 \
    make \
    g++

COPY package.json ./
RUN npm install --production

COPY . .

RUN mkdir -p /app/auth_info

EXPOSE 3000

CMD ["node", "index.js"]
