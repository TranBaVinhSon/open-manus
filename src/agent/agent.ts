import { getChatCompletion, generatePlan } from '../llm';
import { tools } from '../tools';
import { AgentOptions, Plan, Step } from '../types';
import chalk from 'chalk';
import ora from 'ora';
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { z } from 'zod';
import { getSystemPrompt } from './system-prompt';

export class Agent {
  private task: string;
  private maxSteps: number = 20;
  private currentStep: number = 0;
  private tools: Record<string, any>;
  private plan: Plan;
  private researchData: any[] = [];
  private spinner: any;
  private defaultModel: string;

  constructor(options: AgentOptions) {
    this.task = options.task;
    this.maxSteps = options.maxSteps || this.maxSteps;
    this.tools = tools;
    this.plan = {
      task: this.task,
      steps: [],
      currentStepIndex: 0,
      completed: false,
    };
    this.spinner = ora();
    this.defaultModel = process.env.DEFAULT_LLM_MODEL || 'gpt-4o';
  }

  async run(): Promise<void> {
    console.log(`Agent started for task: ${this.task}`);

    // Initialize plan
    await this.initializePlan();

    // Execute each step in the plan
    while (this.currentStep < this.maxSteps && !this.plan.completed) {
      this.currentStep++;
      console.log(`\n--- Step ${this.currentStep} ---`);

      const currentStep = this.plan.steps[this.plan.currentStepIndex];
      if (!currentStep) {
        this.plan.completed = true;
        break;
      }

      try {
        await this.executeStep(currentStep);
        this.plan.currentStepIndex++;
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

  private async initializePlan(): Promise<void> {
    this.spinner.start(chalk.blue('Creating execution plan...'));

    try {
      // Use the generatePlan function from our enhanced LLM module
      const planSteps = await generatePlan(this.task);
      this.plan.steps = planSteps;

      this.spinner.succeed(chalk.green('Plan created successfully'));
      console.log(chalk.yellow('\nPlanned steps:'));
      planSteps.forEach((step) => {
        console.log(chalk.cyan(`${step.id}. ${step.description}`));
      });
    } catch (error) {
      this.spinner.fail(chalk.red('Failed to create plan'));
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
            url: z.string().url().optional().describe('The URL to visit'),
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
    // Only use the result from the most recent completed step
    if (this.plan.currentStepIndex === 0 || this.researchData.length === 0) {
      return 'This is the first step, so there are no previous results.';
    }

    const prevIndex = this.plan.currentStepIndex - 1;
    const prevStep = this.plan.steps[prevIndex];
    if (!prevStep || prevStep.status !== 'completed') {
      return 'The previous step is not completed. No previous results available.';
    }

    let context = `Result from previous step:\n\nStep ${prevIndex + 1}: ${prevStep.description}\n`;
    const stepData = this.researchData.filter(
      (data) => data.stepId === prevStep.id,
    );
    if (stepData.length > 0) {
      context += `Results:\n${JSON.stringify(stepData, null, 2)}\n`;
    } else {
      context += `No specific data collected for this step.\n`;
    }

    return context;
  }

  private async generateReport(): Promise<void> {
    this.spinner.start(chalk.blue('Generating final report...'));

    try {
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
          ${JSON.stringify(this.researchData, null, 2)}
          
          COMPLETED STEPS:
          ${JSON.stringify(this.plan.steps, null, 2)}
          
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

      console.log(chalk.green('\n========================================'));
      console.log(chalk.yellow('REPORT GENERATED SUCCESSFULLY:'));
      console.log(chalk.green('========================================'));
      console.log(chalk.cyan(`- Markdown: ${markdownFilename}`));
      console.log(chalk.cyan(`- HTML: ${htmlFilename}`));
      console.log(chalk.green('========================================\n'));
    } catch (error) {
      this.spinner.fail(chalk.red('Failed to generate report'));
      throw error;
    }
  }
}
