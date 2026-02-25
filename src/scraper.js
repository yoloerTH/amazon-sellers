import { SELECTORS, AMAZON_SELLER_NAMES } from './constants.js';

/**
 * Check if a seller name belongs to Amazon itself.
 */
export function isAmazonSeller(sellerName) {
    if (!sellerName) return false;
    const normalized = sellerName.toLowerCase().trim();
    return AMAZON_SELLER_NAMES.some(name => normalized.includes(name) || name.includes(normalized));
}

/**
 * Delay helper.
 */
export function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extract all sellers from the offer listing page.
 * We navigate directly to /gp/offer-listing/{ASIN} which redirects to
 * the product page with the AOD panel already loaded in the DOM.
 * This is much more reliable than clicking to open the AOD overlay.
 */
export async function extractAllSellers(page, asin, marketplace, log) {
    const offerUrl = `https://www.${marketplace.domain}/gp/offer-listing/${asin}/ref=dp_olp_NEW_mbc?condition=NEW`;

    log.info(`\n[${marketplace.code}] Loading offers: ${offerUrl}`);

    try {
        await page.goto(offerUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await delay(2500);
    } catch (err) {
        log.warning(`[${marketplace.code}] Failed to load offer page: ${err.message}`);
        return [];
    }

    // Check if product exists on this marketplace
    const pageTitle = await page.title();
    const currentUrl = page.url();

    // Detect "not found" or error pages
    if (pageTitle.includes('Page Not Found') || pageTitle.includes('404') ||
        pageTitle.includes('Sorry') || currentUrl.includes('/errors/')) {
        log.info(`[${marketplace.code}] Product not found on this marketplace`);
        return [];
    }

    // Check for cookie consent or CAPTCHA blocking the page
    const hasCaptcha = await page.$('form[action*="validateCaptcha"]') !== null;
    if (hasCaptcha) {
        log.warning(`[${marketplace.code}] CAPTCHA detected — skipping`);
        return [];
    }

    // Extract sellers — the AOD panel is loaded in the DOM after redirect
    const sellers = await page.$$eval('a[href*="/gp/aag/main"]', links => {
        return links.map(a => {
            const href = a.href;
            let sellerId = null;
            try {
                sellerId = new URL(href).searchParams.get('seller');
            } catch {
                const match = href.match(/seller=([A-Z0-9]+)/);
                sellerId = match ? match[1] : null;
            }
            return {
                name: a.textContent.trim(),
                sellerId,
                href,
            };
        }).filter(s => s && s.name && s.sellerId);
    }).catch(() => []);

    // Deduplicate by sellerId
    const unique = [...new Map(sellers.map(s => [s.sellerId, s])).values()];
    log.info(`[${marketplace.code}] Found ${unique.length} seller(s)`);

    return unique;
}

/**
 * Navigate to a seller's profile page and extract business info.
 */
export async function extractSellerInfo(page, sellerUrl, log) {
    try {
        await page.goto(sellerUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await delay(1500);

        const info = await page.evaluate(() => {
            const result = {};

            // Get seller display name from h1
            const h1 = document.querySelector('h1');
            result.sellerDisplayName = h1 ? h1.textContent.trim() : null;

            // Get seller rating info
            try {
                const ratingText = document.body.innerText;
                const ratingMatch = ratingText.match(/([\d.]+)\s*out of\s*5\s*stars/);
                const percentMatch = ratingText.match(/(\d+)%\s*positive/);
                const countMatch = ratingText.match(/\((\d[\d,]*)\s*ratings?\)/);
                result.rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;
                result.positivePercent = percentMatch ? parseInt(percentMatch[1], 10) : null;
                result.ratingCount = countMatch ? parseInt(countMatch[1].replace(/,/g, ''), 10) : null;
            } catch { /* ignore */ }

            // Find "Detailed Seller Information" section
            const headings = Array.from(document.querySelectorAll('h3'));
            const detailHeading = headings.find(h => h.textContent.includes('Detailed Seller Information'));

            if (!detailHeading) {
                result.hasDetailedInfo = false;

                // Fallback: check for "Customer Service Phone" in page text (UAE pattern)
                const csPhoneMatch = document.body.innerText.match(/Customer Service Phone[:\s]+([^\n]+)/i);
                if (csPhoneMatch) {
                    result.phoneNumber = csPhoneMatch[1].trim();
                    result.customerServicePhone = csPhoneMatch[1].trim();
                }

                return result;
            }

            result.hasDetailedInfo = true;
            const container = detailHeading.closest('div[class*="a-column"], div[class*="a-box"], section')
                || detailHeading.parentElement?.parentElement;

            if (!container) return result;

            const allText = container.innerText;
            const lines = allText.split('\n').map(l => l.trim()).filter(Boolean);

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (!line.includes(':')) continue;

                const [rawKey, ...rest] = line.split(':');
                const key = rawKey.trim();
                const value = rest.join(':').trim();

                if (value) {
                    const keyLower = key.toLowerCase();
                    if (keyLower === 'business name') result.businessName = value;
                    else if (keyLower === 'business type') result.businessType = value;
                    else if (keyLower === 'trade register number') result.tradeRegisterNumber = value;
                    else if (keyLower === 'vat number') result.vatNumber = value;
                    else if (keyLower === 'phone number') result.phoneNumber = value;
                    else if (keyLower === 'email') result.email = value;
                } else if (key.toLowerCase() === 'business address' || key.toLowerCase() === 'customer services address') {
                    const addrLines = [];
                    for (let j = i + 1; j < lines.length; j++) {
                        if (lines[j].includes(':') || lines[j].includes('This seller')) break;
                        addrLines.push(lines[j]);
                    }
                    if (key.toLowerCase() === 'business address') {
                        result.businessAddress = addrLines.join(', ');
                    } else {
                        result.customerServiceAddress = addrLines.join(', ');
                    }
                }
            }

            // Also check for "Customer Service Phone" outside Detailed Info
            const csPhoneMatch = document.body.innerText.match(/Customer Service Phone[:\s]+([^\n]+)/i);
            if (csPhoneMatch) {
                result.customerServicePhone = csPhoneMatch[1].trim();
                if (!result.phoneNumber) {
                    result.phoneNumber = csPhoneMatch[1].trim();
                }
            }

            return result;
        });

        if (info.sellerDisplayName) {
            log.info(`    ${info.sellerDisplayName} | Phone: ${info.phoneNumber || 'N/A'} | Email: ${info.email || 'N/A'}`);
        }

        return info;
    } catch (err) {
        log.warning(`    Failed to extract seller info: ${err.message}`);
        return { error: err.message };
    }
}

/**
 * Full scraping flow for one ASIN on one marketplace.
 */
export async function scrapeAsinOnMarketplace(page, asin, marketplace, options, log) {
    const { skipAmazonSellers, delayBetweenRequests } = options;

    // Step 1: Go directly to the offer listing page (loads AOD in DOM)
    const allSellers = await extractAllSellers(page, asin, marketplace, log);

    // Filter out Amazon sellers if needed
    const sellersToVisit = skipAmazonSellers
        ? allSellers.filter(s => {
            if (isAmazonSeller(s.name)) {
                log.info(`[${marketplace.code}] Skipping Amazon seller: ${s.name}`);
                return false;
            }
            return true;
        })
        : allSellers;

    if (sellersToVisit.length === 0) {
        log.info(`[${marketplace.code}] No third-party sellers to visit`);
        return [];
    }

    log.info(`[${marketplace.code}] Visiting ${sellersToVisit.length} seller profile(s)...`);

    // Step 2: Visit each seller's profile page
    const results = [];
    for (const seller of sellersToVisit) {
        await delay(delayBetweenRequests);

        const sellerProfileUrl = `https://www.${marketplace.domain}/sp?seller=${seller.sellerId}&asin=${asin}`;
        const sellerInfo = await extractSellerInfo(page, sellerProfileUrl, log);

        results.push({
            asin,
            marketplace: marketplace.code,
            marketplaceDomain: marketplace.domain,
            sellerName: seller.name,
            sellerId: seller.sellerId,
            sellerDisplayName: sellerInfo.sellerDisplayName || seller.name,
            businessName: sellerInfo.businessName || null,
            businessType: sellerInfo.businessType || null,
            phoneNumber: sellerInfo.phoneNumber || null,
            customerServicePhone: sellerInfo.customerServicePhone || null,
            email: sellerInfo.email || null,
            vatNumber: sellerInfo.vatNumber || null,
            tradeRegisterNumber: sellerInfo.tradeRegisterNumber || null,
            businessAddress: sellerInfo.businessAddress || null,
            customerServiceAddress: sellerInfo.customerServiceAddress || null,
            rating: sellerInfo.rating || null,
            positivePercent: sellerInfo.positivePercent || null,
            ratingCount: sellerInfo.ratingCount || null,
            hasDetailedInfo: sellerInfo.hasDetailedInfo || false,
            scrapedAt: new Date().toISOString(),
        });
    }

    return results;
}
