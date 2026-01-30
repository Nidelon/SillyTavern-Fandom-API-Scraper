declare module 'html-to-text' {
    export interface HtmlToTextOptions {
        wordwrap?: boolean | number | null;
        selectors?: {
            selector: string;
            format?: string;
            options?: any;
        }[];
        [key: string]: any;
    }

    export function convert(html: string, options?: HtmlToTextOptions): string;
}
