FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY backend ./backend
COPY frontend ./frontend
COPY data/gtfs ./data/gtfs

EXPOSE 3000
CMD ["node", "backend/src/server.mjs"]
