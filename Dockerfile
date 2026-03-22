# Lincoln Autonomy Service
# rebrowser-playwright + Chromium for headless Claude.ai automation

FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (npm install to generate fresh lock file)
RUN npm install --omit=dev

# Skip browser install — base image already has Chromium
# Tell Playwright to use the system-installed browsers
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Copy application code
COPY . .

# Create session directory
RUN mkdir -p /app/session

# Set environment defaults
ENV HEADLESS=true
ENV NODE_ENV=production

# Run the wake script
CMD ["node", "src/wake.js"]
