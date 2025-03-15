import chalk from 'chalk';
import ora from 'ora';
import { getChatCompletion } from '../llm';
import { DataEntry } from './memory-store';

/**
 * Options for the report generator
 */
export interface ReportGeneratorOptions {
  task: string;
  fileOperations: {
    writeFile: (filename: string, content: string) => Promise<any>;
  };
  startTime: number;
  stepTimes: Record<number, { start: number; end: number }>;
}

/**
 * Class responsible for generating reports from research data
 */
export class ReportGenerator {
  private task: string;
  private fileOperations: any;
  private spinner: any;
  private startTime: number;
  private stepTimes: Record<number, { start: number; end: number }>;

  constructor(options: ReportGeneratorOptions) {
    this.task = options.task;
    this.fileOperations = options.fileOperations;
    this.spinner = ora();
    this.startTime = options.startTime;
    this.stepTimes = options.stepTimes;
  }

  /**
   * Generate reports from research data
   * @param researchData The collected research data
   */
  async generateReport(researchData: DataEntry[]): Promise<{
    markdownPath: string;
    htmlPath: string;
  }> {
    this.spinner.start(chalk.blue('Generating final report...'));
    const reportStartTime = Date.now();

    try {
      // Create step descriptions from the research data
      const stepDescriptions = researchData.map((entry) => ({
        id: entry.stepId,
        description:
          entry.type === 'search'
            ? entry.data.query
            : entry.type === 'browser'
              ? entry.data.url
              : entry.type === 'fileOperation'
                ? entry.data.filename
                : entry.data.code,
        status: 'completed',
      }));

      // Generate markdown report
      const reportContent = await this.generateMarkdownReport(
        researchData,
        stepDescriptions,
      );

      // Save markdown report
      const timestamp = Date.now();
      const markdownFilename = `results/report-${timestamp}.md`;
      await this.fileOperations.writeFile(markdownFilename, reportContent);
      this.spinner.succeed(chalk.green('Markdown report generated'));

      // Generate HTML report
      this.spinner.start(chalk.blue('Converting to HTML...'));
      const htmlContent = await this.generateHtmlReport(reportContent);

      // Save HTML report
      const htmlFilename = `results/report-${timestamp}.html`;
      await this.fileOperations.writeFile(htmlFilename, htmlContent);
      this.spinner.succeed(chalk.green('HTML report generated'));

      // Add timing information
      await this.addTimingInformation(
        markdownFilename,
        reportContent,
        reportStartTime,
      );

      return {
        markdownPath: markdownFilename,
        htmlPath: htmlFilename,
      };
    } catch (error) {
      this.spinner.fail(chalk.red('Failed to generate report'));

      // Even if report generation fails, still show timing stats
      const endTime = Date.now();
      const totalDuration = (endTime - this.startTime) / 1000;
      console.log(
        chalk.yellow(
          `Total execution time: ${totalDuration.toFixed(2)} seconds (${(
            totalDuration / 60
          ).toFixed(2)} minutes)`,
        ),
      );

      throw error;
    }
  }

  /**
   * Generate a markdown report from research data
   */
  private async generateMarkdownReport(
    researchData: DataEntry[],
    stepDescriptions: any[],
  ): Promise<string> {
    const reportPrompt = [
      {
        role: 'system',
        content:
          'You are an expert report writer who specializes in creating comprehensive and well-structured reports across various domains.',
      },
      {
        role: 'user',
        content: `Create a comprehensive markdown report based on the following:
        
        TASK: ${this.task}
        
        RESEARCH DATA:
        ${JSON.stringify(researchData, null, 2)}
        
        COMPLETED STEPS:
        ${JSON.stringify(stepDescriptions, null, 2)}
        
        Important instructions:
        1. Follow the exact structure provided in the table of contents
        2. Include all section headers exactly as shown in the table of contents
        3. For each completed step, provide a detailed analysis of what was done and what was found
        4. Create proper anchor links that match the table of contents
        5. Where relevant data exists, suggest what type of chart or visualization would be appropriate
        6. Format the report in clean markdown with proper headers, lists, and emphasis
        7. Ensure all anchor IDs match exactly what's in the table of contents for proper navigation
        
        Return the Markdown content only, no other text or comments.`,
      },
    ];

    return await getChatCompletion(reportPrompt);
  }

  /**
   * Generate an HTML report from markdown content
   */
  private async generateHtmlReport(markdownContent: string): Promise<string> {
    const htmlPrompt = [
      {
        role: 'system',
        content:
          'You are an expert at converting markdown to beautiful HTML with CSS styling and interactive JavaScript visualizations.',
      },
      {
        role: 'user',
        content: `Convert this markdown to clean, well-formatted HTML with professional styling:
        ${markdownContent}
        
        Requirements:
        1. Use modern CSS for responsive, professional styling
        2. Include Chart.js (from CDN) for data visualizations
        3. Where the report suggests charts or visualizations, generate the appropriate Chart.js code
        4. Analyze numeric data in the report and create suitable visualizations
        5. Create a collapsible/expandable table of contents for easy navigation
        6. Include smooth scrolling for anchor links
        7. Add a fixed navigation bar that shows current section
        8. Use syntax highlighting for any code blocks
        9. Make all data tables responsive and sortable where appropriate
        10. Ensure the page is self-contained with all needed scripts and styles
        
        Return the HTML content only, no other text or comments.
        `,
      },
    ];

    return await getChatCompletion(htmlPrompt);
  }

  /**
   * Add timing information to the report
   */
  private async addTimingInformation(
    markdownFilename: string,
    reportContent: string,
    reportStartTime: number,
  ): Promise<void> {
    // Calculate timing statistics
    const endTime = Date.now();
    const totalDuration = (endTime - this.startTime) / 1000; // in seconds
    const reportDuration = (endTime - reportStartTime) / 1000; // in seconds

    // Calculate step statistics
    const stepDurations = Object.entries(this.stepTimes)
      .filter(([_, times]) => times.end > 0)
      .map(([stepId, times]) => ({
        stepId: parseInt(stepId),
        duration: (times.end - times.start) / 1000,
      }));

    const averageStepDuration =
      stepDurations.length > 0
        ? stepDurations.reduce((sum, step) => sum + step.duration, 0) /
          stepDurations.length
        : 0;

    const longestStep =
      stepDurations.length > 0
        ? stepDurations.reduce(
            (longest, step) =>
              step.duration > longest.duration ? step : longest,
            stepDurations[0],
          )
        : null;

    // Generate timing report for console
    console.log(chalk.green('\n========================================'));
    console.log(chalk.yellow('EXECUTION TIME STATISTICS:'));
    console.log(chalk.green('========================================'));
    console.log(
      chalk.cyan(
        `Total execution time: ${totalDuration.toFixed(2)} seconds (${(
          totalDuration / 60
        ).toFixed(2)} minutes)`,
      ),
    );
    console.log(
      chalk.cyan(
        `Report generation time: ${reportDuration.toFixed(2)} seconds`,
      ),
    );
    console.log(
      chalk.cyan(
        `Average step duration: ${averageStepDuration.toFixed(2)} seconds`,
      ),
    );
    if (longestStep) {
      console.log(
        chalk.cyan(
          `Longest step: Step ${longestStep.stepId} (${longestStep.duration.toFixed(
            2,
          )} seconds)`,
        ),
      );
    }
    console.log(chalk.green('========================================'));

    // Add timing information to reports
    const timingData = {
      startTime: new Date(this.startTime).toISOString(),
      endTime: new Date(endTime).toISOString(),
      totalDuration: `${totalDuration.toFixed(2)} seconds`,
      stepStats: {
        total: stepDurations.length,
        averageDuration: `${averageStepDuration.toFixed(2)} seconds`,
        longestStep: longestStep
          ? `Step ${longestStep.stepId} (${longestStep.duration.toFixed(
              2,
            )} seconds)`
          : 'N/A',
      },
    };

    // Append timing data to markdown report
    const timingMarkdown = `
## Execution Statistics

- **Start Time:** ${timingData.startTime}
- **End Time:** ${timingData.endTime}
- **Total Duration:** ${timingData.totalDuration}
- **Number of Steps:** ${timingData.stepStats.total}
- **Average Step Duration:** ${timingData.stepStats.averageDuration}
- **Longest Step:** ${timingData.stepStats.longestStep}
`;

    await this.fileOperations.writeFile(
      markdownFilename,
      reportContent + timingMarkdown,
    );

    // Log file paths
    console.log(chalk.green('\n========================================'));
    console.log(chalk.yellow('REPORT GENERATED SUCCESSFULLY:'));
    console.log(chalk.green('========================================'));
    console.log(chalk.cyan(`- Markdown: ${markdownFilename}`));
    console.log(chalk.cyan(`- HTML: results/report-${endTime}.html`));
    console.log(chalk.green('========================================\n'));
  }
}
