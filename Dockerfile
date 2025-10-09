FROM node:18-alpine

# Install Python for userbot
RUN apk add --no-cache python3 py3-pip py3-venv

WORKDIR /app

# Copy package files
COPY server/package*.json ./server/
COPY package.json ./

# Install Node dependencies
RUN cd server && npm install --production

# Create Python virtual environment and install userbot dependencies
COPY userbot/requirements.txt ./userbot/
RUN python3 -m venv /app/venv && \
    . /app/venv/bin/activate && \
    pip install --no-cache-dir -r userbot/requirements.txt

# Copy source code
COPY server/src ./server/src
COPY server/public ./server/public
COPY userbot ./userbot

# Expose port
EXPOSE 8080

# Start the application
CMD ["node", "server/src/index.js"]
