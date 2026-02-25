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
 * The /gp/offer-listing/{ASIN} URL redirects to the product page
 * with offers displayed inline (not in the AOD overlay).
 * We look for seller links using multiple selector strategies.
 */
export async function extractAllSellers(page, asin, marketplace, log) {
    const offerUrl = `https://www.${marketplace.domain}/gp/offer-listing/${asin}/ref=dp_olp_NEW_mbc?condition=NEW`;

    log.info(`\n[${marketplace.code}] Loading offers: ${offerUrl}`);

    try {
        await page.goto(offerUrl, { waitUntil: 'load', timeout: 45000 });
    } catch (err) {
        log.warning(`[${marketplace.code}] Page load timeout, continuing anyway: ${err.message}`);
    }

    // Debug: log where we ended up
    const currentUrl = page.url();
    const pageTitle = await page.title();
    log.info(`[${marketplace.code}] Redirected to: ${currentUrl}`);
    log.info(`[${marketplace.code}] Page title: ${pageTitle}`);

    // Detect "not found" or error pages
    if (pageTitle.includes('Page Not Found') || pageTitle.includes('404') ||
        pageTitle.includes('Sorry') || currentUrl.includes('/errors/')) {
        log.info(`[${marketplace.code}] Product not found on this marketplace`);
        return [];
    }

    // Check for CAPTCHA
    const hasCaptcha = await page.$('form[action*="validateCaptcha"]') !== null;
    if (hasCaptcha) {
        log.warning(`[${marketplace.code}] CAPTCHA detected — skipping`);
        return [];
    }

    // Wait for the offers section to render — try multiple selectors
    const offerSelectors = [
        '#aod-offer-list #aod-offer',          // AOD overlay (if it loads)
        '#aod-offer',                           // AOD offer without list wrapper
        '#all-offers-display',                  // All offers display container
        '#olpOfferList',                        // Older offer listing format
        '.olpOffer',                            // Older offer listing items
        '#ppd',                                 // Product page detail (offers inline)
    ];

    let foundSelector = null;
    for (const sel of offerSelectors) {
        try {
            await page.waitForSelector(sel, { timeout: 5000 });
            foundSelector = sel;
            log.info(`[${marketplace.code}] Found offers with selector: ${sel}`);
            break;
        } catch {
            // Try next selector
        }
    }

    if (!foundSelector) {
        log.info(`[${marketplace.code}] No offer container found, waiting 5s as fallback...`);
        await delay(5000);
    }

    // Debug: log what seller-related links exist on the page
    const debugInfo = await page.evaluate(() => {
        const allLinks = Array.from(document.querySelectorAll('a'));
        const sellerLinks = allLinks.filter(a => {
            const href = a.href || '';
            return href.includes('seller=') || href.includes('/gp/aag/') ||
                   href.includes('/sp?') || href.includes('/seller/');
        });
        return {
            totalLinks: allLinks.length,
            sellerLinkCount: sellerLinks.length,
            sellerLinkSamples: sellerLinks.slice(0, 10).map(a => ({
                text: a.textContent.trim().substring(0, 50),
                href: a.href.substring(0, 150),
            })),
            hasAodOfferList: !!document.querySelector('#aod-offer-list'),
            hasAodOffer: !!document.querySelector('#aod-offer'),
            hasPpd: !!document.querySelector('#ppd'),
            // Check for "Sold by" text patterns
            soldByTexts: Array.from(document.querySelectorAll('*')).filter(el =>
                el.children.length === 0 && el.textContent.trim().match(/^sold by$/i)
            ).length,
        };
    }).catch(() => ({}));

    log.info(`[${marketplace.code}] Debug: ${JSON.stringify(debugInfo)}`);

    // Extract sellers using multiple strategies
    const sellers = await page.evaluate(() => {
        const found = [];
        const seenIds = new Set();

        // Helper to extract seller ID from a URL
        function extractSellerId(href) {
            if (!href) return null;
            try {
                const url = new URL(href);
                return url.searchParams.get('seller') || url.searchParams.get('sellerID');
            } catch {
                const match = href.match(/seller=([A-Z0-9]+)/i);
                return match ? match[1] : null;
            }
        }

        // Strategy 1: Links to /gp/aag/main (seller storefront)
        document.querySelectorAll('a[href*="/gp/aag/main"]').forEach(a => {
            const sellerId = extractSellerId(a.href);
            const name = a.textContent.trim();
            if (sellerId && name && !seenIds.has(sellerId)) {
                seenIds.add(sellerId);
                found.push({ name, sellerId, href: a.href, strategy: 'aag' });
            }
        });

        // Strategy 2: Links containing seller= parameter (covers /sp?seller=, etc.)
        document.querySelectorAll('a[href*="seller="]').forEach(a => {
            const sellerId = extractSellerId(a.href);
            const name = a.textContent.trim();
            if (sellerId && name && !seenIds.has(sellerId)) {
                seenIds.add(sellerId);
                found.push({ name, sellerId, href: a.href, strategy: 'sellerParam' });
            }
        });

        // Strategy 3: "Sold by" pattern — find text "Sold by" followed by a link
        document.querySelectorAll('a').forEach(a => {
            const prevText = a.previousSibling?.textContent || '';
            const parentText = a.parentElement?.textContent || '';
            if ((prevText.toLowerCase().includes('sold by') ||
                 parentText.toLowerCase().includes('sold by')) &&
                a.href && !a.href.includes('#')) {
                const sellerId = extractSellerId(a.href);
                const name = a.textContent.trim();
                if (sellerId && name && !seenIds.has(sellerId)) {
                    seenIds.add(sellerId);
                    found.push({ name, sellerId, href: a.href, strategy: 'soldBy' });
                } else if (name && !sellerId && a.href.includes('/sp')) {
                    // Try to extract from href path
                    const match = a.href.match(/seller[=\/]([A-Z0-9]+)/i);
                    const id = match ? match[1] : null;
                    if (id && !seenIds.has(id)) {
                        seenIds.add(id);
                        found.push({ name, sellerId: id, href: a.href, strategy: 'soldByPath' });
                    }
                }
            }
        });

        return found;
    }).catch(() => []);

    // Deduplicate by sellerId
    const unique = [...new Map(sellers.map(s => [s.sellerId, s])).values()];
    log.info(`[${marketplace.code}] Found ${unique.length} seller(s): ${unique.map(s => `${s.name}(${s.strategy})`).join(', ')}`);

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
