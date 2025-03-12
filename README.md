# open-manus

An experimental AI agent project inspired by Manus. This is a first attempt at building a general-purpose AI agent that performs complex tasks. Built with TypeScript and powered by the Vercel AI SDK.

> **Note**: This project is in early experimental stages and was initially scaffolded using Cursor.

## Architecture

![Open Manus Architecture](/static/open-manus.png)

## Features (Planned/In Development)

- Web search using exa.ai API
- Browser automation with browserbase/stagehand
- Deep search capabilities
- Code Interpreter using Javascript for complex calculations and data analysis
- Computer Use capabilities (file operations, terminal commands, system interactions)
- Report generation in both Markdown and HTML formats
- Step-by-step task execution with planning and reasoning

## Setup

1. Clone the repository:

   ```bash
   git clone https://github.com/TranBaVinhSon/open-manus.git
   cd open-manus
   ```

2. Install dependencies:

   ```bash
   yarn install
   ```

3. Copy the `.env.example` file to `.env` and fill in your API keys:
   ```bash
   cp .env.example .env
   ```
   Then edit the `.env` file with your own API keys:
   ```
   OPENAI_API_KEY=your_openai_api_key_here
   EXA_API_KEY=your_exa_api_key_here
   DEFAULT_LLM_MODEL=gpt-4o-mini
   MAX_SUBTASKS=10
   MAX_STEPS=20
   ```

## Current Status

This project is in its very early stages and is being developed as an experimental implementation. The features listed above are planned but may not all be fully implemented yet. Contributions and feedback are welcome!

## Some Examples

```bash
yarn start -t "Run a thorough SEO audit on Karpathy's website (https://karpathy.ai/) and deliver a detailed optimization report with actionable recommendations."
```

```bash
yarn start -t "Visit the official YC website and compile all enterprise information under the W25 B2B tag into a clear, well-structured table. Be sure to find all of it."
```

```bash
yarn start -t "Research top 5 cloud providers, compare their services and pricing, and create a detailed comparison report"
```

## License

MIT
