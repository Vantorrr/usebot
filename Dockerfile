FROM node:18-alpine

# Install Python for userbot
RUN apk add --no-cache python3 py3-pip

WORKDIR /app

# Copy package files
COPY server/package*.json ./server/
COPY package.json ./

# Install Node dependencies
RUN cd server && npm install --production

# Install userbot dependencies with --break-system-packages
COPY userbot/requirements.txt ./userbot/
RUN pip3 install --no-cache-dir --break-system-packages -r userbot/requirements.txt

# Copy source code
COPY server/src ./server/src
COPY server/public ./server/public
COPY userbot ./userbot

# Expose port
EXPOSE 8080

# Start the application
CMD ["node", "server/src/index.js"]
