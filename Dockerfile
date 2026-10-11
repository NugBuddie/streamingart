FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV DB_PATH=/data/void.db
VOLUME /data
EXPOSE 3000
CMD ["npm", "start"]
