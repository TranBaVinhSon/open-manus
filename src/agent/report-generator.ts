import { getChatCompletion } from '../llm';
import chalk from 'chalk';
import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration';
import { AgentReportFormat } from '../enums/agent';
import { getGenerateAnswerPrompt } from './prompts/generate-answer-prompt';

dayjs.extend(duration);

export interface ExecutionStats {
  executionTimeSeconds: number;
  stepDurations: number[];
  avgStepDuration: number;
  longestStep: number;
  totalSteps: number;
}

export interface ReportGeneratorOptions {
  task: string;
  researchData: any[];
  tools: Record<string, any>;
  spinner: any;
  executionStats: ExecutionStats;
  model?: string;
}

export class ReportGenerator {
  private task: string;
  private researchData: any[];
  private tools: Record<string, any>;
  private spinner: any;
  private executionStats: ExecutionStats;
  private model: string;

  constructor(options: ReportGeneratorOptions) {
    this.task = options.task;
    this.researchData = options.researchData;
    this.tools = options.tools;
    this.spinner = options.spinner;
    this.executionStats = options.executionStats;
    this.model = options.model || process.env.DEFAULT_LLM_MODEL || 'gpt-4o';
  }

  public async generateReport(): Promise<void> {
    this.spinner.start(chalk.blue('Analyzing report requirements...'));

    try {
      const { shouldGenerate, format } =
        await this.shouldGenerateReportAndFormat();

      if (!shouldGenerate) {
        this.spinner.succeed(
          chalk.yellow(
            'No detailed report needed - concise answer already provided',
          ),
        );
        this.generateTerminalResponse();
        this.displayExecutionStats();
        return;
      }

      this.spinner.succeed(
        chalk.green(
          `Report generation needed in ${format.toUpperCase()} format`,
        ),
      );

      switch (format) {
        case AgentReportFormat.MD:
          await this.generateMarkdownReport();
          break;
        case AgentReportFormat.HTML:
          await this.generateHtmlReport();
          break;
        case AgentReportFormat.MDX:
          await this.generateMdxReport();
          break;
        default:
          await this.generateMarkdownReport();
      }
    } catch (error) {
      this.spinner.fail(chalk.red('Failed to process report decision'));
      throw error;
    }
  }

  private async shouldGenerateReportAndFormat(): Promise<{
    shouldGenerate: boolean;
    format: AgentReportFormat;
  }> {
    const shouldGeneratePrompt = [
      {
        role: 'system',
        content:
          'You analyze tasks to determine if a detailed report should be generated. Respond with just yes or no.',
      },
      {
        role: 'user',
        content:
          'Based on this task and research data, should a detailed report be generated? A concise answer has already been displayed in the terminal. Only generate a report if the task requires more detailed information, data visualization, or structured analysis.\n\nAnswer with just "yes" or "no".\n\nTASK: ' +
          this.task +
          '\n\nRESEARCH DATA TYPES: ' +
          this.researchData.map((d) => d.type).join(', ') +
          '\n\nRespond with just ONE of the following: "yes" or "no".',
      },
    ];
    const shouldGenerateResponse = await getChatCompletion(
      shouldGeneratePrompt,
      this.model,
    );
    const shouldGenerate =
      shouldGenerateResponse?.trim().toLowerCase() === 'yes';

    if (!shouldGenerate) {
      return { shouldGenerate, format: AgentReportFormat.MD };
    }

    const formatPrompt = [
      {
        role: 'system',
        content:
          'You analyze tasks to determine the best report format. Respond with just the format name.',
      },
      {
        role: 'user',
        content:
          'Based on this task and research data, which format should the report be generated in? Options: "md", "html", "mdx".\n\nTASK: ' +
          this.task +
          '\n\nRESEARCH DATA TYPES: ' +
          this.researchData.map((d) => d.type).join(', ') +
          '\n\nConsider these guidelines:\n' +
          '- Use "md" for simple text-based reports, documentation, or research summaries\n' +
          '- Use "html" for reports needing interactive elements, data visualization, or rich styling\n' +
          '- Use "mdx" for reports that need React components, complex interactivity, or dashboard-like features\n\n' +
          'Respond with just ONE of the following: "md", "html", or "mdx".',
      },
    ];

    const formatResponse = await getChatCompletion(formatPrompt, this.model);
    const formatStr = formatResponse?.trim().toLowerCase() || 'md';

    let format: AgentReportFormat;
    switch (formatStr) {
      case AgentReportFormat.HTML:
        format = AgentReportFormat.HTML;
        break;
      case AgentReportFormat.MDX:
        format = AgentReportFormat.MDX;
        break;
      default:
        format = AgentReportFormat.MD;
    }

    return { shouldGenerate, format };
  }

  private async generateTerminalResponse(): Promise<void> {
    this.spinner.start(chalk.blue('Generating terminal response...'));

    const terminalResponse = getGenerateAnswerPrompt(
      this.task,
      this.researchData,
    );
    this.spinner.succeed(chalk.green('Terminal response ready'));

    this.displayTerminalResponse(terminalResponse);
    this.displayExecutionStats();
  }

  private displayTerminalResponse(terminalResponse: string): void {
    console.log(chalk.green('\n========================================'));
    console.log(chalk.yellow.bold('📊 TASK RESULT:'));
    console.log(chalk.green('========================================'));

    const styledResponse = terminalResponse
      .replace(/^([^**\n-][^\n:]+:)/gm, (match) => chalk.yellow.bold(match))
      .replace(/^([^**\n-][^\n]+)(?=\n)/m, (match) => chalk.white.bold(match))
      .replace(/\*\*([^*]+)\*\*/g, (_, text) => chalk.cyan.bold(text))
      .replace(/^([ \t]*-[ \t]+)/gm, (match) => chalk.green(match))
      .replace(/\n\n/g, '\n\n');

    console.log(styledResponse);
    console.log(chalk.green('========================================\n'));
  }

  private displayExecutionStats(): void {
    console.log(chalk.green('EXECUTION STATISTICS (TERMINAL ONLY):'));
    console.log(
      chalk.cyan(
        `- Total execution time: ${this.formatTime(this.executionStats.executionTimeSeconds)}`,
      ),
    );
    console.log(
      chalk.cyan(`- Steps completed: ${this.executionStats.totalSteps}`),
    );
    console.log(
      chalk.cyan(
        `- Average step duration: ${this.formatTime(this.executionStats.avgStepDuration)}`,
      ),
    );
    console.log(
      chalk.cyan(
        `- Longest step: ${this.formatTime(this.executionStats.longestStep)}`,
      ),
    );
    console.log(chalk.green('========================================\n'));
  }

  private formatTime(seconds: number): string {
    const duration = dayjs.duration(seconds, 'seconds');

    if (seconds < 60) {
      return `${seconds.toFixed(2)} seconds`;
    } else if (seconds < 3600) {
      return `${duration.format('m')} minutes ${duration.format('s')} seconds`;
    } else {
      return duration.format('H [hours] m [minutes] s [seconds]');
    }
  }

  private async generateMarkdownReport(): Promise<void> {
    const timestamp = Date.now();
    let reportContent = '';
    let outputFilename = '';

    this.spinner.start(chalk.blue('Generating markdown content...'));

    const reportType = await this.determineReportType();
    reportContent = await this.createReportContent(reportType);

    outputFilename = `results/report-${timestamp}.md`;
    await this.tools.fileOperations.writeFile(outputFilename, reportContent);
    this.spinner.succeed(chalk.green('Enhanced markdown report generated'));

    console.log(chalk.green('\n========================================'));
    console.log(chalk.yellow('REPORT GENERATED SUCCESSFULLY:'));
    console.log(chalk.green('========================================'));
    console.log(chalk.cyan(`- Output format: MARKDOWN`));
    console.log(chalk.cyan(`- File: ${outputFilename}`));

    this.displayExecutionStats();
  }

  private async generateHtmlReport(): Promise<void> {
    const timestamp = Date.now();
    let reportContent = '';
    let htmlContent = '';
    let outputFilename = '';

    this.spinner.start(
      chalk.blue('Generating markdown content for HTML conversion...'),
    );
    const reportType = await this.determineReportType();
    reportContent = await this.createReportContent(reportType);
    this.spinner.succeed(
      chalk.green('Markdown content generated for conversion'),
    );

    this.spinner.start(chalk.blue('Creating interactive HTML report...'));
    htmlContent = await this.convertToHtml(reportContent);
    outputFilename = `results/report-${timestamp}.html`;
    await this.tools.fileOperations.writeFile(outputFilename, htmlContent);
    this.spinner.succeed(chalk.green('Interactive HTML report generated'));

    console.log(chalk.green('\n========================================'));
    console.log(chalk.yellow('REPORT GENERATED SUCCESSFULLY:'));
    console.log(chalk.green('========================================'));
    console.log(chalk.cyan(`- Output format: HTML`));
    console.log(chalk.cyan(`- File: ${outputFilename}`));

    this.displayExecutionStats();
  }

  private async generateMdxReport(): Promise<void> {
    const timestamp = Date.now();
    let reportContent = '';
    let mdxContent = '';
    let outputFilename = '';

    this.spinner.start(
      chalk.blue('Generating markdown content for MDX conversion...'),
    );
    const reportType = await this.determineReportType();
    reportContent = await this.createReportContent(reportType);
    this.spinner.succeed(
      chalk.green('Markdown content generated for conversion'),
    );

    this.spinner.start(chalk.blue('Creating MDX dashboard...'));
    mdxContent = await this.convertToMdx(reportContent);
    outputFilename = `results/report-${timestamp}.mdx`;
    await this.tools.fileOperations.writeFile(outputFilename, mdxContent);
    this.spinner.succeed(chalk.green('MDX dashboard generated'));

    console.log(chalk.green('\n========================================'));
    console.log(chalk.yellow('REPORT GENERATED SUCCESSFULLY:'));
    console.log(chalk.green('========================================'));
    console.log(chalk.cyan(`- Output format: MDX`));
    console.log(chalk.cyan(`- File: ${outputFilename}`));

    this.displayExecutionStats();
  }

  private async determineReportType(): Promise<string> {
    const reportTypePrompt = [
      {
        role: 'system',
        content:
          'You analyze tasks and determine the best report format. Respond with just the format name.',
      },
      {
        role: 'user',
        content:
          'Based on this task and research data, what report format would be best? Options: "research", "analysis", "data_visualization", "tutorial". \n\nTASK: ' +
          this.task +
          '\n\nRESEARCH DATA TYPES: ' +
          this.researchData.map((d) => d.type).join(', ') +
          '\n\nRespond with just one word.',
      },
    ];
    return await getChatCompletion(reportTypePrompt, this.model);
  }

  private async createReportContent(reportType: string): Promise<string> {
    const reportPrompt = [
      {
        role: 'system',
        content:
          'You are an expert report writer who specializes in creating comprehensive, visually stunning, and perfectly structured reports for professional audiences. You excel at creating clear hierarchies, engaging summaries, and actionable insights from complex data.',
      },
      {
        role: 'user',
        content:
          'Create a comprehensive, visually stunning markdown report based on the following:\n\n' +
          'TASK: ' +
          this.task +
          '\n\n' +
          'REPORT TYPE: ' +
          reportType +
          '\n\n' +
          'RESEARCH DATA:\n' +
          JSON.stringify(this.researchData, null, 2) +
          '\n\n' +
          'COMPLETED STEPS:\n' +
          JSON.stringify(
            this.researchData.map((data) => ({
              id: data.stepId,
              description:
                data.type === 'search'
                  ? data.data.query
                  : data.type === 'browser'
                    ? data.data.url
                    : data.type === 'fileOperation'
                      ? data.data.filename
                      : data.data.code,
              status: 'completed',
            })),
            null,
            2,
          ) +
          '\n\n' +
          'Important instructions:\n' +
          '1. Create an eye-catching title with emoji and a concise executive summary at the start\n' +
          '2. Follow with a comprehensive table of contents with nested sections\n' +
          '3. Include a "Key Insights" section highlighting 3-5 main takeaways with emoji bulletpoints\n' +
          '4. For each completed step, provide detailed analysis with clear subheadings and insights\n' +
          '5. Use advanced markdown features: tables, code blocks with syntax highlighting, blockquotes for insights, and horizontal rules for section breaks\n' +
          '6. For any numeric data, suggest specific chart types and sample data structures in ```json fenced code blocks\n' +
          '7. Use callout boxes (> blockquotes) to highlight important findings\n' +
          '8. Create a consistent visual hierarchy with clear H1, H2, H3 heading levels\n' +
          '9. Add a "Methodology" section explaining the approach taken\n' +
          '10. Conclude with actionable next steps and recommendations\n' +
          '11. Use appropriate emoji in section headers for improved scannability\n\n' +
          'Return the Markdown content only, no other text or comments.',
      },
    ];

    return await getChatCompletion(reportPrompt, this.model);
  }

  private async convertToHtml(markdownContent: string): Promise<string> {
    const htmlPrompt = [
      {
        role: 'system',
        content:
          'You are an expert frontend developer specializing in creating stunning interactive HTML reports with modern CSS, JavaScript visualizations, and exceptional UX. Your reports are visually impressive and provide delightful user experiences across all devices.',
      },
      {
        role: 'user',
        content:
          'Transform this markdown into a stunning, interactive HTML report:\n' +
          markdownContent +
          '\n\n' +
          'Requirements:\n' +
          '1. Create a modern, professional design with CSS custom properties for theming\n' +
          '2. Add a light/dark mode toggle that saves preference to localStorage\n' +
          '3. Include visualization libraries (Chart.js from CDN) to create appropriate interactive charts\n' +
          '4. Generate beautiful visualizations for any numeric data\n' +
          '5. Create a fixed, collapsible sidebar navigation with active section highlighting\n' +
          '6. Include smooth scrolling and a reading progress indicator\n' +
          '7. Add "copy to clipboard" buttons for all code blocks with syntax highlighting via Prism.js\n' +
          '8. Make all data tables responsive, sortable, and filterable\n' +
          '9. Add print CSS for perfect printing and a "Print Report" button\n' +
          '10. Include a floating TOC button on mobile that expands when clicked\n' +
          '11. Ensure excellent accessibility with proper ARIA attributes and keyboard navigation\n' +
          '12. Add subtle animations and transitions for a polished feel\n' +
          '13. Include a search function to quickly find content\n' +
          '14. Optimize for all screen sizes with responsive breakpoints\n' +
          '15. Ensure the report is completely self-contained with embedded CSS and JS\n\n' +
          'Return ONLY the complete HTML with no explanations or comments outside the HTML document.',
      },
    ];

    return await getChatCompletion(htmlPrompt, this.model);
  }

  private async convertToMdx(markdownContent: string): Promise<string> {
    const mdxPrompt = [
      {
        role: 'system',
        content:
          'You are an expert in creating interactive MDX dashboard reports using React components.',
      },
      {
        role: 'user',
        content:
          'Convert this markdown report into an MDX dashboard with React components:\n' +
          markdownContent +
          '\n\n' +
          'Requirements:\n' +
          '1. Create a full MDX dashboard version of the report\n' +
          "2. Use modern React component libraries (assume they're available in the environment)\n" +
          '3. Create interactive data visualizations with recharts or similar libraries\n' +
          '4. Make all components responsive and interactive\n' +
          '5. Include a dark/light theme toggle\n' +
          '6. Use appropriate React icons for section headers\n' +
          '7. Create an interactive timeline component showing the flow of steps\n' +
          '8. Design for maximum interactivity and user exploration\n' +
          '9. Include code syntax highlighting using proper MDX components\n' +
          '10. Make all tables sortable and filterable\n\n' +
          'Return the complete MDX content only, with no explanations outside the MDX code.',
      },
    ];

    return await getChatCompletion(mdxPrompt, this.model);
  }
}
