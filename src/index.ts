import bodyParser from 'body-parser';
import { Router } from 'express';
import chalk from 'chalk';
import axios from 'axios';
import { convert } from 'html-to-text';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';

interface WikiApiResponse {
    query?: {
        allpages?: Array<{ title: string }>;
    };
    continue?: Record<string, string>;
    parse?: {
        text?: {
            '*': string;
        };
    };
}

interface Page {
    title: string;
    content: string;
}

interface FandomScrapeRequest {
    fandom: string;
    filter: string;
}

interface MediaWikiScrapeRequest {
    url: string;
    filter: string;
}

interface PluginInfo {
    id: string;
    name: string;
    description: string;
}

interface Plugin {
    init: (router: Router) => Promise<void>;
    exit: () => Promise<void>;
    info: PluginInfo;
}

interface ScrapeConfig {
    concurrency: number;
    minDelay: number;
    maxDelay: number;
    autoFilterLangs: boolean;
    listingDelay: number;
}

const MODULE_NAME = '[STFAPIS]';
const MIN_TEXT_LENGTH = 100;
const MAX_RETRIES = 10;
const BASE_RETRY_DELAY = 5000;

const DEFAULT_HEADERS = {
    'User-Agent':
        'SillyTavern-Fandom-API-Scraper/1.0.1 (https://github.com/Nidelon/SillyTavern-Fandom-API-Scraper)',
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
};

const SELECTORS_TO_REMOVE = [
    '.portable-infobox',
    '.navbox',
    '.toc',
    '.wds-tabs',
    '.mw-editsection',
    'style',
    'script',
    '.aside',
    '.printfooter',
    '#catlinks',
    '.gallery',
    '.wikia-gallery',
    '.messagebox',
    '.notice',
    '.error',
    'table',
    'figure',
    'video',
    '.infobox',
    '.reference',
    '.mw-jump-link',
    '#mw-navigation',
    '.ambox',
];

const TEXT_CONVERT_OPTIONS = {
    wordwrap: false,
    selectors: [
        { selector: 'a', options: { ignoreHref: true } },
        { selector: 'img', format: 'skip' },
        { selector: 'table', format: 'skip' },
    ],
};

function getFandomApiUrl(fandom: string): string {
    try {
        fandom = fandom.trim();
        if (fandom.includes('.')) {
            const url = new URL(
                fandom.startsWith('http') ? fandom : `https://${fandom}`,
            );
            if (url.hostname.endsWith('fandom.com')) {
                return `${url.protocol}//${url.hostname}/api.php`;
            }
        }
        return `https://${fandom}.fandom.com/api.php`;
    } catch (error) {
        return `https://${fandom}.fandom.com/api.php`;
    }
}

function getMediaWikiApiUrl(urlStr: string): string {
    let url = urlStr.trim();
    if (url.endsWith('/')) url = url.slice(0, -1);
    if (!url.endsWith('api.php')) {
        return `${url}/api.php`;
    }
    return url;
}

function regexFromString(input: string): RegExp | undefined {
    try {
        const match = input?.match(/(\/?)(.+)\1([a-z]*)/i);
        if (!match) return;
        if (match[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(match[3])) {
            return RegExp(input, 'i');
        }
        return new RegExp(match[2], match[3]);
    } catch {
        return;
    }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const randomSleep = (min: number, max: number) => {
    if (min === 0 && max === 0) return Promise.resolve();
    return sleep(Math.floor(Math.random() * (max - min + 1) + min));
};

async function performScrape(
    apiUrl: string,
    config: ScrapeConfig,
    filter?: RegExp,
): Promise<Page[]> {
    console.log(chalk.blue(MODULE_NAME), `Target API: ${apiUrl}`);
    console.log(
        chalk.gray(MODULE_NAME),
        `Mode: Concurrency=${config.concurrency}, Delay=${config.minDelay}-${config.maxDelay}ms, FilterLangs=${config.autoFilterLangs}`,
    );

    let allPages: Array<{ title: string }> = [];
    const queryParams: any = {
        action: 'query',
        list: 'allpages',
        aplimit: 500,
        apfilterredir: 'nonredirects',
        format: 'json',
    };
    let continueToken: any = null;

    try {
        console.log(chalk.blue(MODULE_NAME), 'Fetching page list...');
        do {
            const params = { ...queryParams, ...continueToken };

            if (config.listingDelay > 0) await sleep(config.listingDelay);

            const response = await axios.get<WikiApiResponse>(apiUrl, {
                params: params,
                headers: DEFAULT_HEADERS,
            });

            const data = response.data;
            if (data.query && data.query.allpages) {
                allPages = allPages.concat(data.query.allpages);
            }

            if (data.continue) {
                continueToken = data.continue;
            } else {
                continueToken = null;
            }

            if (allPages.length % 2000 === 0) {
                console.log(
                    chalk.gray(MODULE_NAME),
                    `Discovered ${allPages.length} pages...`,
                );
            }
        } while (continueToken);
    } catch (err: any) {
        throw new Error(`Failed to fetch page list: ${err.message}`);
    }

    const originalCount = allPages.length;

    if (!filter && config.autoFilterLangs) {
        allPages = allPages.filter(
            (p) => !/\/[a-z]{2,3}(-[a-z]+)?$/i.test(p.title),
        );
        console.log(
            chalk.blue(MODULE_NAME),
            `Auto-filtered language subpages. Remaining: ${allPages.length} (from ${originalCount})`,
        );
    } else if (filter) {
        allPages = allPages.filter((p) => filter.test(p.title));
        console.log(
            chalk.blue(MODULE_NAME),
            `Filtered pages: ${allPages.length} (from ${originalCount})`,
        );
    } else {
        console.log(
            chalk.blue(MODULE_NAME),
            `Total pages to parse: ${allPages.length}`,
        );
    }

    console.log(chalk.blue(MODULE_NAME), 'Starting parsing...');

    const limit = pLimit(config.concurrency);
    const results: Page[] = [];
    let completed = 0;

    const tasks = allPages.map((page) =>
        limit(async () => {
            let attempts = 0;
            let success = false;

            while (!success && attempts < MAX_RETRIES) {
                try {
                    await randomSleep(config.minDelay, config.maxDelay);

                    const response = await axios.get<WikiApiResponse>(apiUrl, {
                        params: {
                            action: 'parse',
                            page: page.title,
                            prop: 'text',
                            format: 'json',
                            disablelimitreport: 1,
                            disableeditsection: 1,
                            redirects: 1,
                        },
                        headers: DEFAULT_HEADERS,
                        timeout: 15000,
                    });

                    const data = response.data;
                    success = true;

                    if (!data.parse || !data.parse.text) return;

                    const html = data.parse.text['*'];
                    const $ = cheerio.load(html);

                    $(SELECTORS_TO_REMOVE.join(', ')).remove();
                    $('h2, h3, h4, h5, h6').each((i, el) => {
                        const next = $(el).next();
                        if (
                            next.length === 0 ||
                            /^h[2-6]$/.test(next[0].name)
                        ) {
                            $(el).remove();
                        }
                    });

                    let text = convert($.html(), TEXT_CONVERT_OPTIONS as any);
                    text = text
                        .replace(/\[edit\]/gi, '')
                        .replace(/[ \t]+/g, ' ')
                        .replace(/\n\s*\n/g, '\n\n')
                        .trim();

                    if (text.length >= MIN_TEXT_LENGTH) {
                        results.push({ title: page.title, content: text });
                    }
                } catch (e: any) {
                    attempts++;
                    const status = e.response ? e.response.status : 'Unknown';

                    if (status === 429) {
                        const waitTime =
                            BASE_RETRY_DELAY * Math.pow(2, attempts - 1);
                        console.log(
                            chalk.yellow(MODULE_NAME),
                            `Rate Limited (429) on "${page.title}". Retrying in ${waitTime / 1000}s...`,
                        );
                        await sleep(waitTime);
                    } else if (
                        status === 503 ||
                        status === 502 ||
                        e.code === 'ECONNRESET'
                    ) {
                        await sleep(2000);
                    } else {
                        if (attempts === 1) {
                            if (config.concurrency < 5) {
                                console.error(
                                    chalk.red(MODULE_NAME),
                                    `Failed "${page.title}": ${e.message} (${status})`,
                                );
                            }
                        }
                        break;
                    }
                }
            }
        }).finally(() => {
            completed++;
            const logStep = config.concurrency > 10 ? 200 : 20;
            if (completed % logStep === 0 || completed === allPages.length) {
                console.log(
                    chalk.gray(MODULE_NAME),
                    `Progress: ${completed}/${allPages.length} | Scraped: ${results.length}`,
                );
            }
        }),
    );

    await Promise.all(tasks);
    return results;
}

export async function init(router: Router): Promise<void> {
    const jsonParser = bodyParser.json();

    router.post(['/probe-mediawiki', '/probe'], (_req, res) => {
        res.sendStatus(204);
    });

    router.post(['/scrape-fandom', '/scrape'], jsonParser, async (req, res) => {
        try {
            const model = req.body as FandomScrapeRequest;
            const apiUrl = getFandomApiUrl(model.fandom);
            const filter = regexFromString(model.filter);

            const config: ScrapeConfig = {
                concurrency: 30,
                minDelay: 0,
                maxDelay: 0,
                autoFilterLangs: false,
                listingDelay: 0,
            };

            const results = await performScrape(apiUrl, config, filter);
            console.log(
                chalk.green(MODULE_NAME),
                `Job Done! Returning ${results.length} pages.`,
            );
            res.json(results);
        } catch (error: any) {
            console.error(chalk.red(MODULE_NAME), error.message);
            res.status(500).send(error.message);
        }
    });

    router.post('/scrape-mediawiki', jsonParser, async (req, res) => {
        try {
            const model = req.body as MediaWikiScrapeRequest;
            const apiUrl = getMediaWikiApiUrl(model.url);
            const filter = regexFromString(model.filter);

            const config: ScrapeConfig = {
                concurrency: 2,
                minDelay: 100,
                maxDelay: 800,
                autoFilterLangs: true,
                listingDelay: 200,
            };

            const results = await performScrape(apiUrl, config, filter);
            console.log(
                chalk.green(MODULE_NAME),
                `Job Done! Returning ${results.length} pages.`,
            );
            res.json(results);
        } catch (error: any) {
            console.error(chalk.red(MODULE_NAME), error.message);
            res.status(500).send(error.message);
        }
    });

    console.log(chalk.green(MODULE_NAME), 'Plugin successfully loaded!');
}

export async function exit(): Promise<void> {
    console.log(chalk.yellow(MODULE_NAME), 'Plugin exited');
}

export const info: PluginInfo = {
    id: 'fandom',
    name: 'Wiki API Scraper',
    description: 'Scraper for MediaWiki/Fandom pages.',
};

const plugin: Plugin = { init, exit, info };
export default plugin;
