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
 * Step 1: Extract primary seller and check for other sellers on the product page.
 * Returns { primarySeller, hasOtherSellers, otherSellersCount }
 */
export async function extractProductPageInfo(page, log) {
    const result = {
        primarySeller: null,
        hasOtherSellers: false,
        otherSellersCount: 0,
    };

    // Try to get primary seller link
    try {
        result.primarySeller = await page.$eval(SELECTORS.PRIMARY_SELLER_LINK, el => {
            const href = el.href;
            const url = new URL(href, location.origin);
            return {
                name: el.textContent.trim(),
                sellerId: url.searchParams.get('seller') || href.match(/seller=([A-Z0-9]+)/)?.[1],
                href,
            };
        });
        log.info(`  Primary seller: ${result.primarySeller.name} (${result.primarySeller.sellerId})`);
    } catch {
        // No seller link — likely sold by Amazon directly
        try {
            const merchantText = await page.$eval(SELECTORS.MERCHANT_INFO, el => el.innerText.trim());
            log.info(`  Primary seller (no link): ${merchantText.replace(/\n/g, ' ')}`);
        } catch {
            log.info('  Could not determine primary seller');
        }
    }

    // Check for "Other sellers" box
    try {
        const otherSellersText = await page.$eval(SELECTORS.OTHER_SELLERS_BOX, el =>
            el.innerText.trim().replace(/\s+/g, ' ')
        );
        result.hasOtherSellers = true;
        const countMatch = otherSellersText.match(/\((\d+)\)/);
        result.otherSellersCount = countMatch ? parseInt(countMatch[1], 10) : 0;
        log.info(`  Other sellers found: ${result.otherSellersCount}`);
    } catch {
        log.info('  No other sellers box found');
    }

    return result;
}

/**
 * Step 2: Open the All Offers Display panel and extract all sellers.
 * Returns array of { name, sellerId, href }
 */
export async function extractSellersFromAOD(page, log) {
    try {
        // Click the "Other sellers" link
        await page.click(SELECTORS.AOD_INGRESS_LINK);
        await page.waitForSelector(SELECTORS.AOD_OFFER_LIST, { timeout: 10000 });
        await delay(2000); // Allow panel to fully render

        // Extract sellers from each offer block
        const sellers = await page.$$eval(
            `${SELECTORS.AOD_OFFER_LIST} ${SELECTORS.AOD_OFFER}`,
            (offers, sellerLinkSelector) => {
                return offers.map(offer => {
                    const link = offer.querySelector(sellerLinkSelector);
                    if (!link) return null;
                    const href = link.href;
                    let sellerId = null;
                    try {
                        sellerId = new URL(href).searchParams.get('seller');
                    } catch {
                        const match = href.match(/seller=([A-Z0-9]+)/);
                        sellerId = match ? match[1] : null;
                    }
                    return {
                        name: link.textContent.trim(),
                        sellerId,
                        href,
                    };
                }).filter(s => s && s.name && s.sellerId);
            },
            SELECTORS.SELLER_LINK_IN_OFFER
        );

        // Deduplicate by sellerId
        const unique = [...new Map(sellers.map(s => [s.sellerId, s])).values()];
        log.info(`  Extracted ${unique.length} unique sellers from AOD panel`);
        return unique;
    } catch (err) {
        log.warning(`  Failed to extract sellers from AOD: ${err.message}`);
        return [];
    }
}

/**
 * Step 3: Navigate to a seller's profile page and extract business info.
 * Returns { sellerName, businessName, phoneNumber, email, ... }
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
                const ratingLink = document.querySelector('a[href="#"][class*="link"]');
                if (ratingLink) {
                    const ratingText = ratingLink.closest('div')?.innerText?.trim();
                    if (ratingText) {
                        const ratingMatch = ratingText.match(/([\d.]+)\s*out of\s*5/);
                        const percentMatch = ratingText.match(/(\d+)%\s*positive/);
                        const countMatch = ratingText.match(/\((\d+)\s*ratings?\)/);
                        result.rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;
                        result.positivePercent = percentMatch ? parseInt(percentMatch[1], 10) : null;
                        result.ratingCount = countMatch ? parseInt(countMatch[1], 10) : null;
                    }
                }
            } catch { /* ignore rating extraction errors */ }

            // Find "Detailed Seller Information" section
            const headings = Array.from(document.querySelectorAll('h3'));
            const detailHeading = headings.find(h => h.textContent.includes('Detailed Seller Information'));

            if (!detailHeading) {
                result.hasDetailedInfo = false;
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
                    // Normalize common key variations
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

            // Fallback: check for "Customer Service Phone" outside Detailed Info (UAE pattern)
            const fullPageText = document.body.innerText;
            const csPhoneMatch = fullPageText.match(/Customer Service Phone[:\s]+([^\n]+)/i);
            if (csPhoneMatch && !result.phoneNumber) {
                result.phoneNumber = csPhoneMatch[1].trim();
            }
            if (csPhoneMatch) {
                result.customerServicePhone = csPhoneMatch[1].trim();
            }

            return result;
        });

        if (info.sellerDisplayName) {
            log.info(`    Seller: ${info.sellerDisplayName} | Phone: ${info.phoneNumber || 'N/A'} | Email: ${info.email || 'N/A'}`);
        }

        return info;
    } catch (err) {
        log.warning(`    Failed to extract seller info from ${sellerUrl}: ${err.message}`);
        return { error: err.message };
    }
}

/**
 * Full scraping flow for one ASIN on one marketplace.
 * Returns array of seller data objects.
 */
export async function scrapeAsinOnMarketplace(page, asin, marketplace, options, log) {
    const { skipAmazonSellers, delayBetweenRequests } = options;
    const productUrl = `https://www.${marketplace.domain}/dp/${asin}`;

    log.info(`\n[${marketplace.code}] Scraping ${productUrl}`);

    try {
        await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await delay(2000);
    } catch (err) {
        log.warning(`[${marketplace.code}] Failed to load product page: ${err.message}`);
        return [];
    }

    // Check if product exists on this marketplace
    const pageTitle = await page.title();
    if (pageTitle.includes('Page Not Found') || pageTitle.includes('404') || pageTitle.includes('Sorry')) {
        log.info(`[${marketplace.code}] Product not found on this marketplace`);
        return [];
    }

    // Step 1: Get product page info
    const productInfo = await extractProductPageInfo(page, log);

    // Collect all sellers to visit
    const sellersToVisit = [];

    // Add primary seller if it has a link (not Amazon)
    if (productInfo.primarySeller) {
        if (skipAmazonSellers && isAmazonSeller(productInfo.primarySeller.name)) {
            log.info(`  Skipping primary seller (Amazon): ${productInfo.primarySeller.name}`);
        } else {
            sellersToVisit.push(productInfo.primarySeller);
        }
    }

    // Step 2: Get other sellers from AOD panel
    if (productInfo.hasOtherSellers) {
        const aodSellers = await extractSellersFromAOD(page, log);
        for (const seller of aodSellers) {
            if (skipAmazonSellers && isAmazonSeller(seller.name)) {
                log.info(`  Skipping seller (Amazon): ${seller.name}`);
                continue;
            }
            // Avoid duplicates with primary seller
            if (!sellersToVisit.find(s => s.sellerId === seller.sellerId)) {
                sellersToVisit.push(seller);
            }
        }
    }

    if (sellersToVisit.length === 0) {
        log.info(`[${marketplace.code}] No third-party sellers to visit`);
        return [];
    }

    log.info(`[${marketplace.code}] Visiting ${sellersToVisit.length} seller profile(s)...`);

    // Step 3: Visit each seller's profile page
    const results = [];
    for (const seller of sellersToVisit) {
        await delay(delayBetweenRequests);

        // Build seller profile URL
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
