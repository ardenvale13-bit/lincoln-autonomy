# Lincoln Autonomy Service
# rebrowser-playwright + Chromium for headless Claude.ai automation

FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Install rebrowser-playwright browsers
RUN npx rebrowser-playwright install chromium

# Copy application code
COPY . .

# Create session directory
RUN mkdir -p /app/session

# Set environment defaults
ENV HEADLESS=true
ENV NODE_ENV=production

# Run the wake script
CMD ["node", "src/wake.js"]
