/**
 * Lincoln Autonomy Wake Service
 * 
 * Uses Playwright to open Claude.ai, navigate to the Lincoln project,
 * and initiate an autonomous session on a schedule.
 * 
 * IMPORTANT: This requires valid session cookies from a logged-in Claude.ai session.
 * Session cookies must be manually refreshed when they expire (~2-4 weeks typically).
 */

const { chromium } = require('playwright');
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

// Load session cookies from ENV or file
async function loadCookies() {
  // First try environment variable (recommended for Railway)
  if (process.env.CLAUDE_COOKIES) {
    try {
      console.log('Loading cookies from CLAUDE_COOKIES env var...');
      const rawCookies = JSON.parse(process.env.CLAUDE_COOKIES);
      return sanitizeCookies(rawCookies);
    } catch (error) {
      console.error('Failed to parse CLAUDE_COOKIES env var:', error.message);
      throw new Error('CLAUDE_COOKIES environment variable contains invalid JSON.');
    }
  }
  
  // Fallback to file
  try {
    const cookiesPath = path.resolve(CONFIG.cookiesPath);
    const cookiesData = await fs.readFile(cookiesPath, 'utf-8');
    const rawCookies = JSON.parse(cookiesData);
    return sanitizeCookies(rawCookies);
  } catch (error) {
    console.error('Failed to load cookies:', error.message);
    throw new Error('No valid session cookies found. Set CLAUDE_COOKIES env var or provide cookies.json file.');
  }
}

// Save updated cookies after session
async function saveCookies(context) {
  try {
    const cookies = await context.cookies();
    const cookiesPath = path.resolve(CONFIG.cookiesPath);
    await fs.mkdir(path.dirname(cookiesPath), { recursive: true });
    await fs.writeFile(cookiesPath, JSON.stringify(cookies, null, 2));
    console.log('Session cookies saved.');
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
// Cloudflare sends to /api/challenge_redirect which runs JS verification
// then redirects back to the intended page. We need to wait for that.
async function waitForChallengeResolution(page, maxWaitMs = 30000) {
  const startTime = Date.now();
  let currentUrl = page.url();

  if (!currentUrl.includes('challenge_redirect') && !currentUrl.includes('challenge')) {
    // No challenge detected, wait a moment for any JS redirects
    await page.waitForTimeout(2000);
    currentUrl = page.url();
    if (!currentUrl.includes('challenge')) {
      return; // No challenge, proceed
    }
  }

  console.log('Cloudflare challenge detected, waiting for resolution...');

  while (Date.now() - startTime < maxWaitMs) {
    currentUrl = page.url();

    // Challenge resolved — we're past it
    if (!currentUrl.includes('challenge_redirect') && !currentUrl.includes('/api/challenge')) {
      console.log(`Challenge resolved. Now at: ${currentUrl}`);
      // Give the destination page a moment to load
      await page.waitForTimeout(3000);
      return;
    }

    // Wait and check again
    await page.waitForTimeout(2000);
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    if (elapsed % 10 === 0) {
      console.log(`Still waiting for challenge... (${elapsed}s) URL: ${currentUrl}`);
    }
  }

  // If we're still on the challenge page after max wait, try to proceed anyway
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
    
    // Launch browser with stealth settings
    console.log('Launching browser...');
    browser = await chromium.launch({
      headless: CONFIG.headless,
      slowMo: CONFIG.slowMo,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-infobars',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--window-size=1920,1080',
      ]
    });

    // Create context with realistic browser fingerprint
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-NZ',
      timezoneId: 'Pacific/Auckland',
      deviceScaleFactor: 1,
      hasTouch: false,
      isMobile: false,
      javaScriptEnabled: true,
      extraHTTPHeaders: {
        'Accept-Language': 'en-NZ,en-US;q=0.9,en;q=0.8',
        'sec-ch-ua': '"Chromium";v="131", "Google Chrome";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
      },
    });

    // Stealth patches — remove automation fingerprints before any page loads
    await context.addInitScript(() => {
      // Remove webdriver flag
      Object.defineProperty(navigator, 'webdriver', { get: () => false });

      // Fake plugins array (real Chrome has plugins)
      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
          { name: 'Native Client', filename: 'internal-nacl-plugin' },
        ],
      });

      // Fake languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-NZ', 'en-US', 'en'],
      });

      // Remove automation-related properties from window
      delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
      delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
      delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;

      // Patch chrome runtime to look real
      window.chrome = {
        runtime: {
          connect: () => {},
          sendMessage: () => {},
          onMessage: { addListener: () => {} },
        },
        loadTimes: () => ({}),
        csi: () => ({}),
      };

      // Fix permissions query to not reveal automation
      const originalQuery = window.navigator.permissions?.query;
      if (originalQuery) {
        window.navigator.permissions.query = (parameters) => (
          parameters.name === 'notifications' ?
            Promise.resolve({ state: Notification.permission }) :
            originalQuery(parameters)
        );
      }
    });

    await context.addCookies(cookies);

    // Create page
    const page = await context.newPage();
    page.setDefaultTimeout(CONFIG.timeout);
    
    // Navigate to homepage first to establish session and pass any challenges
    console.log('Navigating to claude.ai homepage...');
    try {
      await page.goto('https://claude.ai', { waitUntil: 'domcontentloaded', timeout: 30000 });
      console.log(`Homepage status: landed on ${page.url()}`);
    } catch (testError) {
      console.error(`Cannot reach claude.ai at all: ${testError.message}`);
      throw new Error('Cannot connect to claude.ai - possible network/blocking issue');
    }

    // Handle Cloudflare challenge redirect if present
    await waitForChallengeResolution(page);

    // Now navigate to the chat
    const chatUrl = `${CONFIG.claudeBaseUrl}/chat/${CONFIG.chatId}`;
    console.log(`Navigating to chat: ${chatUrl}`);

    try {
      await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      console.log(`Chat navigation landed on: ${page.url()}`);
    } catch (navError) {
      console.error(`Navigation failed: ${navError.message}`);
      const pageContent = await page.content().catch(() => 'Could not get page content');
      console.log(`Page content preview: ${pageContent.substring(0, 500)}`);
      throw navError;
    }

    // Handle challenge redirect again if chat URL triggered one
    await waitForChallengeResolution(page);

    const currentUrl = page.url();
    console.log(`Final URL: ${currentUrl}`);

    // Check if we're actually logged in
    if (currentUrl.includes('login') || currentUrl.includes('oauth')) {
      throw new Error('Session expired - redirected to login page');
    }

    // Wait for the Claude interface to be ready
    console.log('Waiting for Claude interface...');

    const inputSelector = 'div[contenteditable="true"], textarea[placeholder*="Message"], div.ProseMirror';

    await page.waitForSelector(inputSelector, { timeout: 45000 });
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
    
    // Log current URL before sending to verify we're in project
    console.log(`About to send from: ${page.url()}`);
    
    // Use Ctrl+Enter which is typically the send shortcut
    await page.keyboard.press('Control+Enter');
    
    console.log('Prompt sent. Waiting for response...');
    
    // Wait for Claude to respond (look for the response container)
    // This is tricky - we need to wait for the response to complete
    await page.waitForTimeout(5000); // Initial wait for response to start
    
    // Wait for response to finish (no more streaming)
    // Look for indicators that streaming has stopped
    let attempts = 0;
    const maxAttempts = 60; // 60 * 2 seconds = 2 minutes max wait
    
    while (attempts < maxAttempts) {
      await page.waitForTimeout(2000);
      
      // Check if there's still a "stop generating" button visible
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
    
    // Save updated cookies
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
