import bodyParser from 'body-parser';
import { Router, Request, Response } from 'express';
import chalk from 'chalk';
import axios from 'axios';
import { convert } from 'html-to-text';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';

interface WikiApiResponse {
    query?: {
        allpages?: Array<{ title: string }>;
    };
    continue?: {
        apcontinue: string;
    };
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

const MODULE_NAME = '[STFAPIS]';
const CONCURRENCY = 30;
const MIN_TEXT_LENGTH = 100;

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

async function performScrape(apiUrl: string, filter?: RegExp): Promise<Page[]> {
    console.log(chalk.blue(MODULE_NAME), `Target API: ${apiUrl}`);

    let allPages: Array<{ title: string }> = [];
    let apcontinue: string | null = null;

    try {
        console.log(chalk.blue(MODULE_NAME), 'Fetching page list...');
        do {
            const response = await axios.get<WikiApiResponse>(apiUrl, {
                params: {
                    action: 'query',
                    list: 'allpages',
                    aplimit: 500,
                    apfilterredir: 'nonredirects',
                    format: 'json',
                    apcontinue: apcontinue,
                },
            });

            const data = response.data;
            if (data.query && data.query.allpages) {
                allPages = allPages.concat(data.query.allpages);
            }
            apcontinue =
                data.continue && data.continue.apcontinue
                    ? data.continue.apcontinue
                    : null;

            if (allPages.length % 2000 === 0) {
                console.log(
                    chalk.gray(MODULE_NAME),
                    `Discovered ${allPages.length} pages...`,
                );
            }
        } while (apcontinue);
    } catch (err: any) {
        throw new Error(`Failed to fetch page list: ${err.message}`);
    }

    if (filter) {
        const originalCount = allPages.length;
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

    console.log(
        chalk.blue(MODULE_NAME),
        `Starting parsing (Concurrency: ${CONCURRENCY})...`,
    );

    const limit = pLimit(CONCURRENCY);
    const results: Page[] = [];
    let completed = 0;

    const tasks = allPages.map((page) =>
        limit(async () => {
            try {
                const response = await axios.get<WikiApiResponse>(apiUrl, {
                    params: {
                        action: 'parse',
                        page: page.title,
                        prop: 'text',
                        format: 'json',
                        disablelimitreport: 1,
                        disableeditsection: 1,
                    },
                });

                const data = response.data;

                if (!data.parse || !data.parse.text) return;

                const html = data.parse.text['*'];
                const $ = cheerio.load(html);

                $(SELECTORS_TO_REMOVE.join(', ')).remove();

                $('h2, h3, h4, h5, h6').each((i, el) => {
                    const next = $(el).next();
                    if (next.length === 0 || /^h[2-6]$/.test(next[0].name)) {
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
                    results.push({
                        title: page.title,
                        content: text,
                    });
                }
            } catch (e) {
                // Ignore errors
            } finally {
                completed++;
                if (completed % 100 === 0 || completed === allPages.length) {
                    console.log(
                        chalk.gray(MODULE_NAME),
                        `Progress: ${completed}/${allPages.length} | Scraped: ${results.length}`,
                    );
                }
            }
        }),
    );

    await Promise.all(tasks);
    return results;
}

export async function init(router: Router): Promise<void> {
    const jsonParser = bodyParser.json();

    router.post(
        ['/probe-mediawiki', '/probe'],
        (_req: Request, res: Response) => {
            res.sendStatus(204);
            return;
        },
    );

    router.post(
        ['/scrape-fandom', '/scrape'],
        jsonParser,
        async (req: Request, res: Response) => {
            try {
                const model = req.body as FandomScrapeRequest;
                const apiUrl = getFandomApiUrl(model.fandom);
                const filter = regexFromString(model.filter);

                const results = await performScrape(apiUrl, filter);

                console.log(
                    chalk.green(MODULE_NAME),
                    `Job Done! Returning ${results.length} pages.`,
                );
                res.json(results);
            } catch (error: any) {
                console.error(
                    chalk.red(MODULE_NAME),
                    'Scrape failed:',
                    error.message,
                );
                res.status(500).send(error.message);
            }
        },
    );

    router.post(
        '/scrape-mediawiki',
        jsonParser,
        async (req: Request, res: Response) => {
            try {
                const model = req.body as MediaWikiScrapeRequest;
                const apiUrl = getMediaWikiApiUrl(model.url);
                const filter = regexFromString(model.filter);

                const results = await performScrape(apiUrl, filter);

                console.log(
                    chalk.green(MODULE_NAME),
                    `Job Done! Returning ${results.length} pages.`,
                );
                res.json(results);
            } catch (error: any) {
                console.error(
                    chalk.red(MODULE_NAME),
                    'Scrape failed:',
                    error.message,
                );
                res.status(500).send(error.message);
            }
        },
    );

    console.log(chalk.green(MODULE_NAME), 'Plugin successfully loaded!');
}

export async function exit(): Promise<void> {
    console.log(chalk.yellow(MODULE_NAME), 'Plugin exited');
}

export const info: PluginInfo = {
    id: 'fandom',
    name: 'Fandom API Scraper',
    description: 'Scraper for Fandom pages.',
};

const plugin: Plugin = {
    init,
    exit,
    info,
};

export default plugin;
