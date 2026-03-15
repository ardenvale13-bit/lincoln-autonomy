# Lincoln Autonomy Service
# Playwright + Chromium for headless Claude.ai automation

FROM mcr.microsoft.com/playwright:v1.42.0-jammy

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# Create session directory
RUN mkdir -p /app/session

# Set environment defaults
ENV HEADLESS=true
ENV NODE_ENV=production

# Run the wake script
CMD ["node", "src/wake.js"]
