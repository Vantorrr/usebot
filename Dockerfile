FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY server/package*.json ./server/
COPY package.json ./

# Install Node dependencies
RUN cd server && npm install --production

# Copy source code (web/admin only)
COPY server/src ./server/src
COPY server/public ./server/public

# Expose port
EXPOSE 8080

# Start the Node server
CMD ["node", "server/src/index.js"]
