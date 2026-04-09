# NanoClaw Agent Container
# Base image with system deps + npm packages.
# Source code (agent-runner, entrypoint) is bind-mounted at runtime
# so the image only needs rebuilding when dependencies change.

FROM node:22-slim

# Install system dependencies for Chromium + transparent proxy support
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    openssh-client \
    iptables \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser and claude-code globally
RUN npm install -g agent-browser @anthropic-ai/claude-code

# Create app directory and install agent-runner dependencies
WORKDIR /app
COPY agent-runner/package*.json ./
RUN npm install

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Stub entrypoint — real one is bind-mounted at runtime by container-runner
RUN printf '#!/bin/bash\necho "FATAL: entrypoint.sh not mounted. Check container-runner.ts mounts." >&2\nexit 1\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# NOTE: No USER directive — entrypoint starts as root for iptables setup,
# then drops ALL capabilities and switches to node user via setpriv.

WORKDIR /workspace/group
ENTRYPOINT ["/app/entrypoint.sh"]
