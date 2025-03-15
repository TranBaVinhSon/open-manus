import { getChatCompletion } from '../llm';
import { tools } from '../tools';
import { AgentOptions, Plan, Step } from '../types';
import chalk from 'chalk';
import ora from 'ora';
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { z } from 'zod';
import { getSystemPrompt } from './system-prompt';
import { generateObject } from 'ai';
import { MemoryStore } from './memory-store';
import { ReportGenerator } from './report-generator';

/**
 * Interface for data entries stored in memory
 */
export class Agent {
  private task: string;
  private maxSteps: number = 20;
  private currentStep: number = 0;
  private tools: Record<string, any>;
  private memory: MemoryStore = new MemoryStore();
  private spinner: any;
  private defaultModel: string;
  private cachedSystemPrompt: string | null = null; // Cache system prompt
  private startTime: number = 0; // Track execution start time
  private stepTimes: Record<number, { start: number; end: number }> = {}; // Track individual step times

  constructor(options: AgentOptions) {
    this.task = options.task;
    this.maxSteps = options.maxSteps || this.maxSteps;
    this.tools = tools;
    this.spinner = ora();
    this.defaultModel = process.env.DEFAULT_LLM_MODEL || 'gpt-4o';
  }

  async run(): Promise<void> {
    // Record start time
    this.startTime = Date.now();
    console.log(`Agent started for task: ${this.task}`);
    console.log(`Start time: ${new Date(this.startTime).toISOString()}`);

    // Pre-cache the system prompt to avoid repeated function calls
    this.cachedSystemPrompt = getSystemPrompt(this.task);

    // Execute steps dynamically until completion or max steps reached
    while (this.currentStep < this.maxSteps) {
      this.currentStep++;
      console.log(`\n--- Step ${this.currentStep} ---`);

      try {
        // Determine the next step based on previous results
        const nextStep = await this.determineNextStep();

        // Check if task is complete
        if (nextStep.isComplete) {
          console.log(chalk.green(`Task completed: ${nextStep.reason}`));
          break;
        }

        // Execute the determined step
        await this.executeStep(nextStep.step);
      } catch (error) {
        console.error(`Error executing step ${this.currentStep}:`, error);
        break;
      }
    }

    // Generate final report
    if (this.memory.length > 0) {
      await this.generateReport();
    }

    console.log(`Agent completed after ${this.currentStep} steps.`);
  }

  private async determineNextStep(): Promise<{
    step: Step;
    isComplete: boolean;
    reason?: string;
  }> {
    // Record step start time
    this.stepTimes[this.currentStep] = {
      start: Date.now(),
      end: 0,
    };

    this.spinner.start(chalk.blue('Determining next step...'));

    try {
      // Get context from previous steps
      const previousStepsContext = this.memory.getFormattedContext();

      const { object } = await generateObject({
        model: openai(this.defaultModel),
        system: this.cachedSystemPrompt!,
        schema: z.object({
          isComplete: z
            .boolean()
            .describe('Whether the overall task is complete'),
          reason: z
            .string()
            .optional()
            .describe(
              'Reason why the task is complete or what needs to be done next',
            ),
          step: z
            .object({
              id: z.number(),
              description: z.string(),
              status: z
                .enum(['pending', 'running', 'completed', 'failed'])
                .default('pending'),
              params: z.record(z.any()).optional(),
            })
            .optional(),
        }),
        prompt: `You are a strategic planning assistant that determines the next step in a complex task.

        OVERALL TASK: "${this.task}"
        
        CURRENT PROGRESS:
        ${previousStepsContext}
        
        AVAILABLE TOOLS:
        - search: For web search operations
        - browser: For web browsing, navigating pages, and extracting information
        - fileOperations: For reading, writing, or manipulating files
        - javascriptExecutor: For running JavaScript code
        
        DETERMINE THE NEXT STEP:
        1. Analyze the current progress and the overall task
        2. Decide if the task is complete or what needs to be done next
        3. If the task is not complete, provide a specific, actionable next step
        4. The step should be detailed and tailored to the specific task
        5. Consider which tool would be most appropriate for this step
        
        If you determine the task is complete, set isComplete to true and explain why in the reason field.
        If more work is needed, set isComplete to false, provide the next step details, and explain your reasoning.`,
      });

      this.spinner.succeed(chalk.green('Next step determined'));

      if (object.isComplete) {
        return {
          isComplete: true,
          reason: object.reason,
          step: {
            id: this.currentStep,
            description: 'Task completed',
            status: 'completed',
          },
        };
      } else {
        const step: Step = {
          id: this.currentStep,
          description:
            object.step?.description || 'Error: No step description provided',
          status: 'pending',
          params: object.step?.params || {},
        };

        console.log(chalk.yellow('\nNext step:'));
        console.log(chalk.cyan(`${step.id}. ${step.description}`));

        return {
          isComplete: false,
          reason: object.reason,
          step,
        };
      }
    } catch (error) {
      this.spinner.fail(chalk.red('Failed to determine next step'));
      console.error(error);
      throw error;
    }
  }

  private async executeStep(step: Step): Promise<void> {
    console.log(`Executing: ${step.description}`);
    step.status = 'running';

    try {
      // Format previous steps results to provide as context
      const previousStepsContext = this.memory.getFormattedContext();

      // Create tools config for Vercel AI SDK
      const aiTools = {
        search: {
          description: 'Search the web for information',
          parameters: z.object({
            query: z.string().describe('The search query'),
          }),
          execute: async ({ query }: { query: string }) => {
            const result = await this.tools.search.execute(query);
            return result;
          },
        },

        browser: {
          description: 'Browse a specific URL and extract information',
          parameters: z.object({
            url: z
              .string()
              .url()
              .describe('The URL to visit to complete the task'),
            goal: z
              .string()
              .optional()
              .describe('Goal of the browsing session'),
          }),
          execute: async (params: { url?: string; goal?: string }) => {
            const result = await this.tools.browser.execute(params);
            return result;
          },
        },

        fileOperations: {
          description: 'Perform file operations like reading or writing files',
          parameters: z.object({
            operation: z.enum(['read', 'write']),
            filename: z.string().describe('Path to the file'),
            content: z
              .string()
              .optional()
              .describe('Content to write (for write operation)'),
          }),
          execute: async ({
            operation,
            filename,
            content,
          }: {
            operation: 'read' | 'write';
            filename: string;
            content?: string;
          }) => {
            if (operation === 'write' && content) {
              return await this.tools.fileOperations.writeFile(
                filename,
                content,
              );
            } else if (operation === 'read') {
              return await this.tools.fileOperations.readFile(filename);
            }
            return { success: false, message: 'Invalid operation' };
          },
        },

        // TOOD: Adding tool to access terminal. It's too dangerous to let AI access terminal without any guardrail implementation
        // terminal: {
        //   description: 'Execute shell commands in the system terminal',
        //   parameters: z.object({
        //     command: z.string().describe('Shell command to execute'),
        //     workingDir: z
        //       .string()
        //       .optional()
        //       .describe('Working directory for command execution'),
        //     timeout: z.number().optional().describe('Timeout in milliseconds'),
        //   }),
        //   execute: async (params: {
        //     command: string;
        //     workingDir?: string;
        //     timeout?: number;
        //   }) => {
        //     return await this.tools.terminal.execute(params);
        //   },
        // },

        javascriptExecutor: {
          description: 'Execute JavaScript code',
          parameters: z.object({
            code: z.string().describe('JavaScript code to execute'),
          }),
          execute: async ({ code }: { code: string }) => {
            return await this.tools.javascriptExecutor.execute({ code });
          },
        },
      };

      // Use LLM to determine which tool to use and how to use it
      const result = await generateText({
        model: openai(this.defaultModel),
        tools: aiTools,
        prompt:
          this.cachedSystemPrompt! +
          `\n\nCurrent step: ${step.description}\nStep parameters: ${JSON.stringify(step.params || {})}\n\nPrevious steps results: ${previousStepsContext}\n\nUse the appropriate tool to complete this step. Be precise and thorough.`,
        maxSteps: 1,
      });

      if (result.toolCalls && result.toolCalls.length > 0) {
        // Process each tool call
        for (let i = 0; i < result.toolCalls.length; i++) {
          const toolCall = result.toolCalls[i];

          // Get the corresponding result by index position
          const toolResult = result.toolResults
            ? result.toolResults[i]
            : undefined;

          if (toolResult) {
            const type =
              toolCall.toolName === 'fileOperations'
                ? 'fileOperation'
                : toolCall.toolName === 'javascriptExecutor'
                  ? 'javascriptExecution'
                  : toolCall.toolName;

            // Store the result in our enhanced memory structure
            this.memory.addResult(step.id, type, toolResult);
          }
        }
      }

      step.status = 'completed';

      // Record step end time
      if (this.stepTimes[step.id]) {
        this.stepTimes[step.id].end = Date.now();
        const stepDuration =
          (this.stepTimes[step.id].end - this.stepTimes[step.id].start) / 1000;
        console.log(
          chalk.dim(`Step duration: ${stepDuration.toFixed(2)} seconds`),
        );
      }

      console.log(chalk.green(`Completed step: ${step.description}`));
      console.log(chalk.dim('Research data updated:'));
      // Only show the most recent data for better readability
      const recentData = this.memory.getResultsByStepId(step.id);
      console.log(JSON.stringify(recentData, null, 2));
    } catch (error) {
      step.status = 'failed';
      step.error = (error as Error).message;
      console.error(chalk.red(`Step failed: ${(error as Error).message}`));
      throw error;
    }
  }

  private async generateReport(): Promise<void> {
    this.spinner.start(chalk.blue('Generating final report...'));
    const reportStartTime = Date.now();

    try {
      // Get all data in a format suitable for report generation
      const allData = this.memory.getAllData();

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
          ${JSON.stringify(allData, null, 2)}
          
          COMPLETED STEPS:
          ${JSON.stringify(
            allData.map((entry) => ({
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
            })),
            null,
            2,
          )}
          
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

      const reportContent = await getChatCompletion(reportPrompt);

      // Save as markdown
      const timestamp = Date.now();
      const markdownFilename = `results/report-${timestamp}.md`;
      await this.tools.fileOperations.writeFile(
        markdownFilename,
        reportContent,
      );

      this.spinner.succeed(chalk.green('Markdown report generated'));
      this.spinner.start(chalk.blue('Converting to HTML...'));

      // Convert to HTML with styling
      const htmlPrompt = [
        {
          role: 'system',
          content:
            'You are an expert at converting markdown to beautiful HTML with CSS styling and interactive JavaScript visualizations.',
        },
        {
          role: 'user',
          content: `Convert this markdown to clean, well-formatted HTML with professional styling:
          ${reportContent}
          
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

      const htmlContent = await getChatCompletion(htmlPrompt);

      const htmlFilename = `results/report-${timestamp}.html`;
      await this.tools.fileOperations.writeFile(htmlFilename, htmlContent);

      this.spinner.succeed(chalk.green('HTML report generated'));

      // Calculate and display timing information
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

      // Generate timing report
      console.log(chalk.green('\n========================================'));
      console.log(chalk.yellow('EXECUTION TIME STATISTICS:'));
      console.log(chalk.green('========================================'));
      console.log(
        chalk.cyan(
          `Total execution time: ${totalDuration.toFixed(2)} seconds (${(totalDuration / 60).toFixed(2)} minutes)`,
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
            `Longest step: Step ${longestStep.stepId} (${longestStep.duration.toFixed(2)} seconds)`,
          ),
        );
      }
      console.log(chalk.green('========================================'));

      // Add timing information to reports as well
      const timingData = {
        startTime: new Date(this.startTime).toISOString(),
        endTime: new Date(endTime).toISOString(),
        totalDuration: `${totalDuration.toFixed(2)} seconds`,
        stepStats: {
          total: stepDurations.length,
          averageDuration: `${averageStepDuration.toFixed(2)} seconds`,
          longestStep: longestStep
            ? `Step ${longestStep.stepId} (${longestStep.duration.toFixed(2)} seconds)`
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

      await this.tools.fileOperations.writeFile(
        markdownFilename,
        reportContent + timingMarkdown,
      );

      console.log(chalk.green('\n========================================'));
      console.log(chalk.yellow('REPORT GENERATED SUCCESSFULLY:'));
      console.log(chalk.green('========================================'));
      console.log(chalk.cyan(`- Markdown: ${markdownFilename}`));
      console.log(chalk.cyan(`- HTML: ${htmlFilename}`));
      console.log(chalk.green('========================================\n'));
    } catch (error) {
      this.spinner.fail(chalk.red('Failed to generate report'));

      // Even if report generation fails, still show timing stats
      const endTime = Date.now();
      const totalDuration = (endTime - this.startTime) / 1000;
      console.log(
        chalk.yellow(
          `Total execution time: ${totalDuration.toFixed(2)} seconds (${(totalDuration / 60).toFixed(2)} minutes)`,
        ),
      );

      throw error;
    }
  }
}
