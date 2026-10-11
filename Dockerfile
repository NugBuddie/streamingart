FROM node:22-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY . .
ENV DB_PATH=/data/void.db
VOLUME /data
EXPOSE 3000
CMD ["npm", "start"]
