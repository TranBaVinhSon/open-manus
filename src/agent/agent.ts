import { getChatCompletion } from '../llm';
import { tools } from '../tools';
import { AgentOptions, Plan, Step, FormatReportType } from '../types';
import chalk from 'chalk';
import ora from 'ora';
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { z } from 'zod';
import { getSystemPrompt } from './system-prompt';
import { generateObject } from 'ai';
import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration';
import { AgentReportFormat } from '../enums/agent';

dayjs.extend(duration);

export class Agent {
  private task: string;
  private maxSteps: number = 20;
  private currentStep: number = 0;
  private tools: Record<string, any>;
  private researchData: any[] = [];
  private spinner: any;
  private defaultModel: string;
  private startTime: bigint;

  constructor(options: AgentOptions) {
    this.task = options.task;
    this.maxSteps = options.maxSteps || this.maxSteps;
    this.tools = tools;
    this.spinner = ora();
    this.defaultModel = process.env.DEFAULT_LLM_MODEL || 'gpt-4o';
    this.startTime = process.hrtime.bigint();
  }

  async run(): Promise<void> {
    console.log(`Agent started for task: ${this.task}`);

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
    if (this.researchData.length > 0) {
      await this.generateReport();
    }

    console.log(`Agent completed after ${this.currentStep} steps.`);
  }

  private async determineNextStep(): Promise<{
    step: Step;
    isComplete: boolean;
    reason?: string;
  }> {
    this.spinner.start(chalk.blue('Determining next step...'));

    try {
      // Get context from previous steps
      const previousStepsContext = this.getPreviousStepsContext();

      const { object } = await generateObject({
        model: openai(this.defaultModel),
        system: getSystemPrompt(this.task),
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
      const previousStepsContext = this.getPreviousStepsContext();

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
          getSystemPrompt(this.task) +
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
            switch (toolCall.toolName) {
              case 'search':
                this.researchData.push({
                  type: 'search',
                  stepId: step.id,
                  data: toolResult,
                });
                break;
              case 'browser':
                this.researchData.push({
                  type: 'browser',
                  stepId: step.id,
                  data: toolResult,
                });
                break;
              case 'fileOperations':
                this.researchData.push({
                  type: 'fileOperation',
                  stepId: step.id,
                  data: toolResult,
                });
                break;
              // case 'terminal':
              //   this.researchData.push({
              //     type: 'terminal',
              //     stepId: step.id,
              //     data: toolResult,
              //   });
              //   break;
              case 'javascriptExecutor':
                this.researchData.push({
                  type: 'javascriptExecution',
                  stepId: step.id,
                  data: toolResult,
                });
                break;
            }
          }
        }
      }

      step.status = 'completed';

      console.log(chalk.green(`Completed step: ${step.description}`));
      console.log(chalk.dim('Research data updated:'));
      console.log(JSON.stringify(this.researchData, null, 2));
    } catch (error) {
      step.status = 'failed';
      step.error = (error as Error).message;
      console.error(chalk.red(`Step failed: ${(error as Error).message}`));
      throw error;
    }
  }

  private getPreviousStepsContext(): string {
    if (this.currentStep === 1) {
      return 'This is the first step, so there are no previous results.';
    }

    let context = `Progress so far:\n\n`;

    // Include all previous research data with step information
    this.researchData.forEach((data, index) => {
      context += `Step ${data.stepId}: ${data.type} operation\n`;
      context += `Results:\n${JSON.stringify(data.data, null, 2)}\n\n`;
    });

    return context;
  }

  private calculateExecutionStats() {
    const endTime = process.hrtime.bigint();
    const executionTimeSeconds =
      Number(endTime - this.startTime) / 1_000_000_000;

    const stepDurations = this.researchData.map((data, index, array) => {
      return index > 0
        ? (array[index].stepId - array[index - 1].stepId) *
            (executionTimeSeconds / this.currentStep)
        : executionTimeSeconds / this.currentStep;
    });

    const avgStepDuration =
      stepDurations.length > 0
        ? stepDurations.reduce((a, b) => a + b, 0) / stepDurations.length
        : 0;

    const longestStep =
      stepDurations.length > 0 ? Math.max(...stepDurations) : 0;

    return {
      executionTimeSeconds,
      stepDurations,
      avgStepDuration,
      longestStep,
      totalSteps: this.currentStep,
    };
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

  private async generateReport(): Promise<void> {
    this.spinner.start(chalk.blue('Analyzing task requirements...'));

    try {
      const formatPrompt = [
        {
          role: 'system',
          content:
            'You analyze tasks to determine the required output format. Respond with just the format name.',
        },
        {
          role: 'user',
          content:
            'Based on this task, which format should the report be generated in? Options: "md", "html", "mdx". If no specific format is mentioned, respond with "md" as default.\n\nTASK: ' +
            this.task +
            '\n\nRespond with just ONE of the following: "md", "html", or "mdx".',
        },
      ];
      const requestedFormat = await getChatCompletion(formatPrompt);
      const format = (requestedFormat || AgentReportFormat.MD)
        .trim()
        .toLowerCase();

      this.spinner.succeed(chalk.green(`Output format determined: ${format}`));

      const timestamp = Date.now();
      let reportContent = '';
      let outputFilename = '';

      if (
        format === AgentReportFormat.MD ||
        format === AgentReportFormat.HTML ||
        format === AgentReportFormat.MDX
      ) {
        this.spinner.start(chalk.blue('Generating markdown content...'));

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
        const reportType = await getChatCompletion(reportTypePrompt);

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

        reportContent = await getChatCompletion(reportPrompt);

        if (format === AgentReportFormat.MD) {
          outputFilename = `results/report-${timestamp}.md`;
          await this.tools.fileOperations.writeFile(
            outputFilename,
            reportContent,
          );
          this.spinner.succeed(
            chalk.green('Enhanced markdown report generated'),
          );
        } else {
          this.spinner.succeed(
            chalk.green('Markdown content generated for conversion'),
          );
        }
      }

      if (format === AgentReportFormat.HTML) {
        this.spinner.start(chalk.blue('Creating interactive HTML report...'));

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
              reportContent +
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

        const htmlContent = await getChatCompletion(htmlPrompt);
        outputFilename = `results/report-${timestamp}.html`;
        await this.tools.fileOperations.writeFile(outputFilename, htmlContent);
        this.spinner.succeed(chalk.green('Interactive HTML report generated'));
      }

      if (format === AgentReportFormat.MDX) {
        this.spinner.start(chalk.blue('Creating MDX dashboard...'));

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
              reportContent +
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

        const mdxContent = await getChatCompletion(mdxPrompt);
        outputFilename = `results/report-${timestamp}.mdx`;
        await this.tools.fileOperations.writeFile(outputFilename, mdxContent);
        this.spinner.succeed(chalk.green('MDX dashboard generated'));
      }

      const stats = this.calculateExecutionStats();

      console.log(chalk.green('\n========================================'));
      console.log(chalk.yellow('REPORT GENERATED SUCCESSFULLY:'));
      console.log(chalk.green('========================================'));
      console.log(chalk.cyan(`- Output format: ${format.toUpperCase()}`));
      console.log(chalk.cyan(`- File: ${outputFilename}`));
      console.log(chalk.green('\nEXECUTION STATISTICS (TERMINAL ONLY):'));
      console.log(
        chalk.cyan(
          `- Total execution time: ${this.formatTime(stats.executionTimeSeconds)}`,
        ),
      );
      console.log(chalk.cyan(`- Steps completed: ${stats.totalSteps}`));
      console.log(
        chalk.cyan(
          `- Average step duration: ${this.formatTime(stats.avgStepDuration)}`,
        ),
      );
      console.log(
        chalk.cyan(`- Longest step: ${this.formatTime(stats.longestStep)}`),
      );
      console.log(chalk.green('========================================\n'));
    } catch (error) {
      this.spinner.fail(chalk.red('Failed to generate report'));
      throw error;
    }
  }
}
