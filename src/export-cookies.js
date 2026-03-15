/**
 * Cookie Export Helper
 * 
 * This script helps you export cookies from your browser session.
 * 
 * INSTRUCTIONS:
 * 
 * 1. Open Claude.ai in Chrome and make sure you're logged in
 * 2. Open DevTools (F12)
 * 3. Go to Application tab → Cookies → https://claude.ai
 * 4. You need to export these cookies in JSON format
 * 
 * OPTION A: Use a browser extension like "EditThisCookie" or "Cookie-Editor"
 *   - Export as JSON
 *   - Save to lincoln-autonomy/session/cookies.json
 * 
 * OPTION B: Use this console script in DevTools:
 * 
 * Copy and paste this into the DevTools Console while on claude.ai:
 * 
 * ```javascript
 * (function() {
 *   const cookies = document.cookie.split(';').map(c => {
 *     const [name, ...valueParts] = c.trim().split('=');
 *     return {
 *       name: name,
 *       value: valueParts.join('='),
 *       domain: '.claude.ai',
 *       path: '/',
 *       secure: true,
 *       httpOnly: false,
 *       sameSite: 'Lax'
 *     };
 *   });
 *   console.log(JSON.stringify(cookies, null, 2));
 *   copy(JSON.stringify(cookies, null, 2));
 *   alert('Cookies copied to clipboard!');
 * })();
 * ```
 * 
 * Note: This won't capture httpOnly cookies, which are the important ones.
 * For full cookie export, you need a browser extension or manual extraction
 * from DevTools Application tab.
 * 
 * REQUIRED COOKIES (at minimum):
 * - __cf_bm (Cloudflare)
 * - __cflb (Cloudflare load balancer)
 * - sessionKey or similar auth token
 * - Any other claude.ai specific session cookies
 * 
 * The cookies.json should look like:
 * [
 *   {
 *     "name": "sessionKey",
 *     "value": "sk-ant-...",
 *     "domain": ".claude.ai",
 *     "path": "/",
 *     "secure": true,
 *     "httpOnly": true,
 *     "sameSite": "Lax"
 *   },
 *   ...
 * ]
 */

const fs = require('fs');
const path = require('path');

const COOKIES_PATH = path.join(__dirname, '..', 'session', 'cookies.json');

// Check if cookies exist
function checkCookies() {
  try {
    const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
    console.log(`Found ${cookies.length} cookies in session file.`);
    console.log('\nCookie names:');
    cookies.forEach(c => console.log(`  - ${c.name}`));
    
    // Check for critical cookies
    const criticalCookies = ['sessionKey', '__cf_bm', 'lastActiveOrg'];
    const found = criticalCookies.filter(name => 
      cookies.some(c => c.name.includes(name))
    );
    
    console.log(`\nCritical cookies found: ${found.length}/${criticalCookies.length}`);
    if (found.length < criticalCookies.length) {
      console.log('⚠️  Some critical cookies may be missing. Session might not work.');
    }
    
    return true;
  } catch (error) {
    console.log('❌ No cookies.json found at:', COOKIES_PATH);
    console.log('\nPlease export cookies from your browser. See instructions above.');
    return false;
  }
}

if (require.main === module) {
  checkCookies();
}

module.exports = { checkCookies, COOKIES_PATH };
