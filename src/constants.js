export const MARKETPLACES = [
    { code: 'UK', domain: 'amazon.co.uk', currency: 'GBP', tld: 'co.uk' },
    { code: 'IE', domain: 'amazon.ie', currency: 'EUR', tld: 'ie' },
    { code: 'DE', domain: 'amazon.de', currency: 'EUR', tld: 'de' },
    { code: 'NL', domain: 'amazon.nl', currency: 'EUR', tld: 'nl' },
    { code: 'SE', domain: 'amazon.se', currency: 'SEK', tld: 'se' },
    { code: 'BE', domain: 'amazon.com.be', currency: 'EUR', tld: 'com.be' },
    { code: 'PL', domain: 'amazon.pl', currency: 'PLN', tld: 'pl' },
    { code: 'ES', domain: 'amazon.es', currency: 'EUR', tld: 'es' },
    { code: 'IT', domain: 'amazon.it', currency: 'EUR', tld: 'it' },
    { code: 'AE', domain: 'amazon.ae', currency: 'AED', tld: 'ae' },
    { code: 'JP', domain: 'amazon.co.jp', currency: 'JPY', tld: 'co.jp' },
    { code: 'SA', domain: 'amazon.sa', currency: 'SAR', tld: 'sa' },
    { code: 'TR', domain: 'amazon.com.tr', currency: 'TRY', tld: 'com.tr' },
];

export const AMAZON_SELLER_NAMES = [
    'amazon', 'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.it',
    'amazon.es', 'amazon.nl', 'amazon.pl', 'amazon.se', 'amazon.com.be',
    'amazon.ie', 'amazon.ae', 'amazon.co.jp', 'amazon.sa', 'amazon.com.tr',
    'amazon uk', 'amazon eu s.a.r.l.', 'amazon eu', 'amazon europe',
];

export const SELECTORS = {
    // Product page
    PRIMARY_SELLER_LINK: '#sellerProfileTriggerId',
    MERCHANT_INFO: '#merchantInfoFeature_feature_div',
    OTHER_SELLERS_BOX: '#dynamic-aod-ingress-box',
    AOD_INGRESS_LINK: '#aod-ingress-link',

    // All Offers Display panel
    AOD_OFFER_LIST: '#aod-offer-list',
    AOD_OFFER: '#aod-offer',
    SELLER_LINK_IN_OFFER: 'a[href*="/gp/aag/main"]',

    // Seller profile page
    SELLER_NAME_HEADING: 'h1',
};
