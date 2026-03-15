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
  cookiesPath: process.env.COOKIES_PATH || './session/cookies.json',
  promptsDir: process.env.PROMPTS_DIR || './prompts',
  headless: process.env.HEADLESS !== 'false', // Default true for Railway
  slowMo: parseInt(process.env.SLOW_MO) || 100, // Milliseconds between actions
  timeout: parseInt(process.env.TIMEOUT) || 120000, // 2 minutes max
  discordWebhook: process.env.DISCORD_WEBHOOK || null, // For session expiry alerts
};

// Determine which prompt to use based on NZ time
function getSessionType() {
  const nzTime = new Date().toLocaleString('en-NZ', { 
    timeZone: 'Pacific/Auckland',
    hour: 'numeric',
    hour12: false 
  });
  const hour = parseInt(nzTime);
  
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 17) return 'midday';
  return 'evening';
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
    
    // Navigate to Claude project and start new chat
    // Try the /new?project= pattern to start a chat directly in project context
    const projectChatUrl = `${CONFIG.claudeBaseUrl}/new?project=${CONFIG.projectId}`;
    console.log(`Navigating to: ${projectChatUrl}`);
    await page.goto(projectChatUrl, { waitUntil: 'networkidle' });
    
    // Log where we actually ended up
    const currentUrl = page.url();
    console.log(`Landed on: ${currentUrl}`);
    
    // Check if we're actually logged in
    if (currentUrl.includes('login') || currentUrl.includes('oauth')) {
      throw new Error('Session expired - redirected to login page');
    }
    
    // Check if we're in the project - ALWAYS go to project page to ensure context
    console.log('Navigating to project page to ensure project context...');
    try {
      await page.goto(`${CONFIG.claudeBaseUrl}/project/${CONFIG.projectId}`, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(2000);
      console.log(`Now at: ${page.url()}`);
    } catch (navError) {
      console.error('Navigation error:', navError.message);
      // Try with less strict wait condition
      await page.goto(`${CONFIG.claudeBaseUrl}/project/${CONFIG.projectId}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      console.log(`After fallback, now at: ${page.url()}`);
    }
    
    // Wait for the page to be ready
    console.log('Waiting for Claude interface...');
    
    // Look for the new chat button or message input
    // Note: These selectors may need adjustment based on Claude.ai's actual DOM structure
    const inputSelector = 'div[contenteditable="true"], textarea[placeholder*="Message"], div.ProseMirror';
    
    await page.waitForSelector(inputSelector, { timeout: 30000 });
    console.log('Interface loaded.');
    
    // Click "New chat" if we're in an existing conversation
    // (This selector will need verification)
    try {
      const newChatButton = await page.$('button:has-text("New chat"), a:has-text("New chat")');
      if (newChatButton) {
        await newChatButton.click();
        await page.waitForTimeout(2000);
      }
    } catch (e) {
      // May already be in new chat state, continue
    }
    
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
