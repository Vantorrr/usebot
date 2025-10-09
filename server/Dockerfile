FROM node:20-alpine
WORKDIR /app
COPY package.json /app/
RUN npm install --production
COPY src /app/src
COPY public /app/public
EXPOSE 8080
CMD ["node", "src/index.js"]


