# open-manus

An experimental AI agent project inspired by Manus. This is an attempt at building a general-purpose AI agent that performs complex tasks. Built with TypeScript and powered by the Vercel AI SDK.

> **Note**: This project is in early experimental stages and was initially scaffolded using Cursor.

## Architecture

![Open Manus Architecture](/static/open-manus.png)

## Demo

<video width="640" height="360" controls>
  <source src="https://github.com/user-attachments/assets/f1d425e9-b0f6-4479-81f4-b1a69bef6224" type="video/mp4">
  Your browser does not support the video tag. <a href="https://github.com/user-attachments/assets/f1d425e9-b0f6-4479-81f4-b1a69bef6224">Click here to view the demo video</a>
</video>

<p>Example: "Visit the official YC website and compile all enterprise information from F24 and B2B tag into a clear, well-structured table. Be sure to find all of it."</p>

## Features (Planned/In Development)

- Web search using exa.ai API
- Browser automation with browserbase/stagehand
- Deep search capabilities
- Code Interpreter using Javascript for complex calculations and data analysis
- Computer Use capabilities (file operations, terminal commands, system interactions)
- Running agent inside isolated environment such as remote server or docker container
- Comprehensive report generation in both Markdown and HTML formats
- Step-by-step task execution with planning and reasoning
- Interactive CLI (User can give input during the task execution process)
- Running GAIA benchmark

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
   TASK_PLANNING_MODEL=o3-mini
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
