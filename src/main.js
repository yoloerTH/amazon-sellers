import { Actor, log } from 'apify';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { MARKETPLACES } from './constants.js';
import { scrapeAsinOnMarketplace, delay } from './scraper.js';

// Apply stealth plugin
chromium.use(StealthPlugin());

await Actor.init();

// ── Input ──────────────────────────────────────────────────────────────
const input = await Actor.getInput() ?? {};
const {
    asins = ['B07YDVWL4J'],
    maxAsins = 0,
    marketplaces: selectedMarketplaces = [],
    delayBetweenRequests = 3000,
    skipAmazonSellers = true,
} = input;

// Determine which ASINs to process
const asinsToProcess = maxAsins > 0 ? asins.slice(0, maxAsins) : asins;

// Determine which marketplaces to scrape
const marketplacesToScrape = selectedMarketplaces.length > 0
    ? MARKETPLACES.filter(m => selectedMarketplaces.includes(m.code))
    : MARKETPLACES;

log.info('=== Amazon Seller Scraper ===');
log.info(`ASINs to process: ${asinsToProcess.length}`);
log.info(`Marketplaces: ${marketplacesToScrape.map(m => m.code).join(', ')}`);
log.info(`Delay between requests: ${delayBetweenRequests}ms`);
log.info(`Skip Amazon sellers: ${skipAmazonSellers}`);
log.info('');

// ── Browser Setup ──────────────────────────────────────────────────────
const browser = await chromium.launch({
    headless: true,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
    ],
});

const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
});

const page = await context.newPage();

// Block unnecessary resources for speed
await page.route('**/*.{png,jpg,jpeg,gif,svg,ico,woff,woff2,ttf,eot}', route => route.abort());
await page.route('**/doubleclick.net/**', route => route.abort());
await page.route('**/google-analytics.com/**', route => route.abort());
await page.route('**/googletagmanager.com/**', route => route.abort());

// ── Scraping Loop ──────────────────────────────────────────────────────
const allResults = [];
const sellersSeen = new Map(); // sellerId -> first marketplace found

for (const asin of asinsToProcess) {
    log.info(`\n${'='.repeat(60)}`);
    log.info(`Processing ASIN: ${asin}`);
    log.info(`${'='.repeat(60)}`);

    for (const marketplace of marketplacesToScrape) {
        try {
            const sellers = await scrapeAsinOnMarketplace(page, asin, marketplace, {
                skipAmazonSellers,
                delayBetweenRequests,
            }, log);

            for (const seller of sellers) {
                // Track cross-marketplace deduplication
                const dedupeKey = `${seller.sellerId}`;
                if (sellersSeen.has(dedupeKey)) {
                    seller.firstSeenOnMarketplace = sellersSeen.get(dedupeKey);
                    seller.isDuplicate = true;
                } else {
                    sellersSeen.set(dedupeKey, marketplace.code);
                    seller.firstSeenOnMarketplace = marketplace.code;
                    seller.isDuplicate = false;
                }

                allResults.push(seller);
                await Actor.pushData(seller);
            }
        } catch (err) {
            log.error(`[${marketplace.code}] Unexpected error for ASIN ${asin}: ${err.message}`);
        }

        // Delay between marketplace switches
        await delay(delayBetweenRequests);
    }
}

// ── Summary ────────────────────────────────────────────────────────────
log.info(`\n${'='.repeat(60)}`);
log.info('SCRAPING COMPLETE');
log.info(`${'='.repeat(60)}`);
log.info(`Total seller records: ${allResults.length}`);
log.info(`Unique sellers: ${sellersSeen.size}`);
log.info(`ASINs processed: ${asinsToProcess.length}`);
log.info(`Marketplaces checked: ${marketplacesToScrape.length}`);

// Count sellers with phone numbers
const withPhone = allResults.filter(r => r.phoneNumber).length;
const withEmail = allResults.filter(r => r.email).length;
log.info(`Records with phone: ${withPhone}`);
log.info(`Records with email: ${withEmail}`);

// ── Cleanup ────────────────────────────────────────────────────────────
await page.close();
await context.close();
await browser.close();

await Actor.exit();
