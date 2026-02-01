# SillyTavern Fandom API Scraper

A SillyTavern server plugin designed to dump an entire MediaWiki/Fandom Wiki into a text file for RAG.

### IMPORTANT: MediaWiki parsing can take too long due to aggressive rate limits. I recommend using the Fandom version of the wiki you want to scrape.

## Installation

1. **Enable Plugins in SillyTavern**
   Open `config.yaml` in your main SillyTavern directory and set:

    ```yaml
    enableServerPlugins: true
    ```

2. **Clone the Repository**
   Navigate to the `plugins` folder and clone the project:

    ```bash
    cd plugins
    git clone https://github.com/Nidelon/SillyTavern-Fandom-API-Scraper
    ```

3. **Install Dependencies and Build**
   Navigate into the plugin directory and run the setup:
    ```bash
    cd SillyTavern-Fandom-API-Scraper
    npm i
    npm run build
    ```

## Warning

**Do not install this plugin alongside the official [SillyTavern-Fandom-Scraper](https://github.com/SillyTavern/SillyTavern-Fandom-Scraper).**

This plugin is maintained separately so I can update it more easily. Using both will cause conflicts.

## License

AGPLv3
