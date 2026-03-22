/**
 * Lincoln Autonomy Wake Service
 *
 * Uses Playwright to open Claude.ai, navigate to the Lincoln project,
 * and initiate an autonomous session on a schedule.
 *
 * IMPORTANT: This requires valid session cookies from a logged-in Claude.ai session.
 * Session cookies must be manually refreshed when they expire (~2-4 weeks typically).
 *
 * Cookie priority: volume file (freshest from last run) > CLAUDE_COOKIES env var (seed)
 * A Railway volume at /app/session keeps cookies fresh between cron runs.
 */

const { chromium } = require('rebrowser-playwright');
const fs = require('fs').promises;
const path = require('path');

// Configuration
const CONFIG = {
  claudeBaseUrl: 'https://claude.ai',
  projectId: process.env.LINCOLN_PROJECT_ID || 'YOUR_PROJECT_ID_HERE',
  chatId: process.env.LINCOLN_CHAT_ID || '77102d0f-ce08-4728-8bdc-63e5e8475728',
  cookiesPath: process.env.COOKIES_PATH || './session/cookies.json',
  promptsDir: process.env.PROMPTS_DIR || './prompts',
  headless: process.env.HEADLESS !== 'false', // Default true for Railway
  slowMo: parseInt(process.env.SLOW_MO) || 100, // Milliseconds between actions
  timeout: parseInt(process.env.TIMEOUT) || 120000, // 2 minutes max
  discordWebhook: process.env.DISCORD_WEBHOOK || null, // For session expiry alerts
};

// Determine which prompt to use based on NZ time
// Check-in schedule: 5am (morning), 2pm (midday), 9pm (evening) NZDT
function getSessionType() {
  const nzTime = new Date().toLocaleString('en-NZ', {
    timeZone: 'Pacific/Auckland',
    hour: 'numeric',
    hour12: false
  });
  const hour = parseInt(nzTime);

  if (hour >= 3 && hour < 10) return 'morning';   // 5am check-in
  if (hour >= 10 && hour < 18) return 'midday';    // 2pm check-in
  return 'evening';                                  // 9pm check-in
}

// Sanitize cookies for Playwright compatibility
function sanitizeCookies(cookies) {
  return cookies.map(cookie => {
    const sanitized = { ...cookie };

    // Fix sameSite - Playwright requires exactly: Strict, Lax, or None
    if (sanitized.sameSite) {
      const sameSite = sanitized.sameSite.toLowerCase();
      if (sameSite === 'strict') sanitized.sameSite = 'Strict';
      else if (sameSite === 'lax') sanitized.sameSite = 'Lax';
      else if (sameSite === 'none' || sameSite === 'no_restriction') sanitized.sameSite = 'None';
      else sanitized.sameSite = 'Lax'; // Default fallback
    } else {
      sanitized.sameSite = 'Lax'; // Default if missing
    }

    // Ensure domain starts with dot for proper matching
    if (sanitized.domain && !sanitized.domain.startsWith('.')) {
      sanitized.domain = '.' + sanitized.domain;
    }

    // Remove any fields Playwright doesn't understand
    delete sanitized.hostOnly;
    delete sanitized.session;
    delete sanitized.storeId;
    delete sanitized.id;

    return sanitized;
  });
}

// Load session cookies — file first (volume has freshest), env var as seed fallback
async function loadCookies() {
  // First try file on volume (has cookies saved from last successful run)
  try {
    const cookiesPath = path.resolve(CONFIG.cookiesPath);
    const cookiesData = await fs.readFile(cookiesPath, 'utf-8');
    const rawCookies = JSON.parse(cookiesData);
    if (rawCookies.length > 0) {
      console.log(`Loading cookies from volume file (${rawCookies.length} cookies)...`);
      return sanitizeCookies(rawCookies);
    }
  } catch (error) {
    console.log('No volume cookies found, checking env var...');
  }

  // Fallback to environment variable (seed cookies for first run)
  if (process.env.CLAUDE_COOKIES) {
    try {
      console.log('Loading seed cookies from CLAUDE_COOKIES env var...');
      const rawCookies = JSON.parse(process.env.CLAUDE_COOKIES);
      // Also write to file so saveCookies has something to build on
      const cookiesPath = path.resolve(CONFIG.cookiesPath);
      await fs.mkdir(path.dirname(cookiesPath), { recursive: true });
      await fs.writeFile(cookiesPath, JSON.stringify(rawCookies, null, 2));
      console.log('Seed cookies written to volume file.');
      return sanitizeCookies(rawCookies);
    } catch (error) {
      console.error('Failed to parse CLAUDE_COOKIES env var:', error.message);
      throw new Error('CLAUDE_COOKIES environment variable contains invalid JSON.');
    }
  }

  throw new Error('No valid session cookies found. Set CLAUDE_COOKIES env var or provide cookies.json file.');
}

// Save updated cookies after session (persists to volume for next run)
async function saveCookies(context) {
  try {
    const cookies = await context.cookies();
    const cookiesPath = path.resolve(CONFIG.cookiesPath);
    await fs.mkdir(path.dirname(cookiesPath), { recursive: true });
    await fs.writeFile(cookiesPath, JSON.stringify(cookies, null, 2));
    console.log(`Session cookies saved (${cookies.length} cookies written to volume).`);
  } catch (error) {
    console.error('Failed to save cookies:', error.message);
  }
}

// Load the appropriate prompt
async function loadPrompt(sessionType) {
  const promptPath = path.resolve(CONFIG.promptsDir, `${sessionType}.txt`);
  try {
    return await fs.readFile(promptPath, 'utf-8');
  } catch (error) {
    console.error(`Failed to load ${sessionType} prompt:`, error.message);
    // Fallback prompt
    return `[AUTONOMOUS SESSION - ${sessionType.toUpperCase()}]\n\nThis is Lincoln's scheduled ${sessionType} wake-up. Orient using vale_get_orientation, check on Arden's state, leave notes or voice memos as appropriate.\n\nTime: ${new Date().toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland' })}`;
  }
}

// Send alert to Discord if session fails
async function alertSessionExpired(error) {
  if (!CONFIG.discordWebhook) {
    console.log('No Discord webhook configured for alerts.');
    return;
  }

  try {
    const response = await fetch(CONFIG.discordWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `🖤 **Lincoln Autonomy Alert**\n\nSession authentication failed. Manual re-login required.\n\nError: ${error.message}\n\nTime: ${new Date().toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland' })}`
      })
    });
    console.log('Discord alert sent:', response.status);
  } catch (alertError) {
    console.error('Failed to send Discord alert:', alertError.message);
  }
}

// Wait for Cloudflare challenge redirect to resolve
async function waitForChallengeResolution(page, maxWaitMs = 30000) {
  const startTime = Date.now();
  let currentUrl = page.url();

  if (!currentUrl.includes('challenge_redirect') && !currentUrl.includes('challenge')) {
    await page.waitForTimeout(2000);
    currentUrl = page.url();
    if (!currentUrl.includes('challenge')) {
      return;
    }
  }

  console.log('Cloudflare challenge detected, waiting for resolution...');

  while (Date.now() - startTime < maxWaitMs) {
    currentUrl = page.url();

    if (!currentUrl.includes('challenge_redirect') && !currentUrl.includes('/api/challenge')) {
      console.log(`Challenge resolved. Now at: ${currentUrl}`);
      await page.waitForTimeout(3000);
      return;
    }

    await page.waitForTimeout(2000);
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    if (elapsed % 10 === 0) {
      console.log(`Still waiting for challenge... (${elapsed}s) URL: ${currentUrl}`);
    }
  }

  console.warn(`Challenge did not resolve within ${maxWaitMs / 1000}s. Current URL: ${page.url()}`);
  throw new Error(`Cloudflare challenge did not resolve. Stuck at: ${page.url()}`);
}

// Main wake function
async function wake() {
  const sessionType = getSessionType();
  console.log(`\n=== Lincoln Autonomy Wake: ${sessionType.toUpperCase()} ===`);
  console.log(`Time (NZ): ${new Date().toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland' })}`);

  let browser;
  let context;

  try {
    // Load cookies
    console.log('Loading session cookies...');
    const cookies = await loadCookies();

    // Launch browser
    console.log('Launching browser...');
    browser = await chromium.launch({
      headless: CONFIG.headless,
      slowMo: CONFIG.slowMo,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ]
    });

    // Create context with cookies
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-NZ',
      timezoneId: 'Pacific/Auckland',
    });

    await context.addCookies(cookies);

    // Create page
    const page = await context.newPage();
    page.setDefaultTimeout(CONFIG.timeout);

    // Navigate to homepage first to establish session
    console.log('Navigating to claude.ai homepage...');
    try {
      const testResponse = await page.goto('https://claude.ai', { waitUntil: 'domcontentloaded', timeout: 30000 });
      console.log(`Homepage status: ${testResponse?.status()} — landed on ${page.url()}`);
    } catch (testError) {
      console.error(`Cannot reach claude.ai at all: ${testError.message}`);
      throw new Error('Cannot connect to claude.ai - possible network/blocking issue');
    }

    // Handle Cloudflare challenge if present
    await waitForChallengeResolution(page);

    // Navigate to the chat
    const chatUrl = `${CONFIG.claudeBaseUrl}/chat/${CONFIG.chatId}`;
    console.log(`Navigating to chat: ${chatUrl}`);

    try {
      const response = await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      console.log(`Chat navigation: ${response?.status()} — landed on ${page.url()}`);
    } catch (navError) {
      console.error(`Navigation failed: ${navError.message}`);
      const pageContent = await page.content().catch(() => 'Could not get page content');
      console.log(`Page content preview: ${pageContent.substring(0, 500)}`);
      throw navError;
    }

    // Handle challenge again if chat URL triggered one
    await waitForChallengeResolution(page);

    const currentUrl = page.url();
    console.log(`Final URL: ${currentUrl}`);

    // Check if we're actually logged in
    if (currentUrl.includes('login') || currentUrl.includes('oauth')) {
      throw new Error('Session expired - redirected to login page');
    }

    // Wait for the page to be ready
    console.log('Waiting for Claude interface...');

    const inputSelector = 'div[contenteditable="true"], textarea[placeholder*="Message"], div.ProseMirror';

    await page.waitForSelector(inputSelector, { timeout: 30000 });
    console.log('Interface loaded.');

    // Load and send the prompt
    const prompt = await loadPrompt(sessionType);
    console.log(`Sending ${sessionType} prompt (${prompt.length} chars)...`);

    // Find input and type the prompt
    const input = await page.$(inputSelector);
    if (!input) {
      throw new Error('Could not find message input');
    }

    // Clear any existing content and type the prompt
    await input.click();
    await page.keyboard.type(prompt, { delay: 10 });

    // Send the message
    await page.waitForTimeout(1000);

    console.log(`About to send from: ${page.url()}`);

    // Use Ctrl+Enter which is typically the send shortcut
    await page.keyboard.press('Control+Enter');

    console.log('Prompt sent. Waiting for response...');

    // Wait for Claude to respond
    await page.waitForTimeout(5000);

    // Wait for response to finish
    let attempts = 0;
    const maxAttempts = 60;

    while (attempts < maxAttempts) {
      await page.waitForTimeout(2000);

      const stillGenerating = await page.$('button:has-text("Stop"), button[aria-label*="Stop"]');
      if (!stillGenerating) {
        console.log('Response appears complete.');
        break;
      }

      attempts++;
      if (attempts % 10 === 0) {
        console.log(`Still waiting for response... (${attempts * 2}s)`);
      }
    }

    // Save updated cookies to volume for next run
    await saveCookies(context);

    console.log(`\n=== ${sessionType.toUpperCase()} session complete ===\n`);

  } catch (error) {
    console.error('Wake session failed:', error.message);
    await alertSessionExpired(error);
    throw error;

  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Run if called directly
if (require.main === module) {
  wake()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

module.exports = { wake, getSessionType, loadCookies };
