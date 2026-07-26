FROM node:20-alpine
WORKDIR /app

# Instala dependencias primero (mejor cache)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copia el resto (server + web + assets)
COPY . .

ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
