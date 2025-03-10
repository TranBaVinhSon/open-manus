import {
  getChatCompletion,
  generatePlan,
  getReasoningCompletion,
} from '../llm';
import { tools } from '../tools';
import { AgentOptions, Plan, Step } from '../types';
import chalk from 'chalk';
import ora from 'ora';
import { marked } from 'marked';
import { openai } from '@ai-sdk/openai';
import { generateText, tool } from 'ai';
import { z } from 'zod';

export class Agent {
  private task: string;
  private maxSteps: number = 20;
  private currentStep: number = 0;
  private tools: Record<string, any>;
  private plan: Plan;
  private researchData: any[] = [];
  private spinner: any;

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
      // Create tools config for Vercel AI SDK
      const aiTools = {
        search: tool({
          description: 'Search the web for information',
          parameters: z.object({
            query: z.string().describe('The search query'),
          }),
          execute: async ({ query }) => {
            const result = await this.tools.search.execute(query);
            return result;
          },
        }),

        browser: tool({
          description: 'Browse a specific URL and extract information',
          parameters: z.object({
            url: z.string().url().optional().describe('The URL to visit'),
            goal: z
              .string()
              .optional()
              .describe('Goal of the browsing session'),
          }),
          execute: async (params) => {
            const result = await this.tools.browser.execute(params);
            return result;
          },
        }),

        fileOperations: tool({
          description: 'Perform file operations like reading or writing files',
          parameters: z.object({
            operation: z.enum(['read', 'write']),
            filename: z.string(),
            content: z.string().optional(),
          }),
          execute: async ({ operation, filename, content }) => {
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
        }),

        javascriptExecutor: tool({
          description: 'Execute JavaScript code',
          parameters: z.object({
            code: z.string().describe('JavaScript code to execute'),
          }),
          execute: async ({ code }) => {
            return await this.tools.javascriptExecutor.execute({ code });
          },
        }),
      };

      // Use LLM to determine which tool to use and how to use it
      const result = await generateText({
        model: openai(process.env.OPENAI_MODEL || 'gpt-4o-mini'),
        tools: aiTools,
        prompt: `You are an AI assistant helping with a task. Based on the current step of the task:
        
        Step description: ${step.description}
        Step parameters: ${JSON.stringify(step.params || {})}
        
        Use the appropriate tool to complete this step. Be precise and thorough.`,
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
                  data: toolResult,
                });
                break;
              case 'browser':
                this.researchData.push({
                  type: 'browser',
                  data: toolResult,
                });
                break;
              case 'fileOperations':
                this.researchData.push({
                  type: 'fileOperation',
                  data: toolResult,
                });
                break;
              case 'javascriptExecutor':
                this.researchData.push({
                  type: 'javascriptExecution',
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

  private generateTableOfContents(): string {
    this.spinner.start(chalk.blue('Generating table of contents...'));

    try {
      // Extract relevant information from the plan and executed steps
      const mainTask = this.task;

      // Create TOC header
      let tableOfContents = `# ${mainTask}\n\n## Table of Contents\n\n`;

      // Add executive summary and introduction
      tableOfContents += `1. [Executive Summary](#executive-summary)\n`;
      tableOfContents += `2. [Introduction](#introduction)\n`;

      // Add methodology section with executed steps
      tableOfContents += `3. [Methodology](#methodology)\n`;

      // Group steps by their tool category for better organization
      const toolCategories: Record<string, Step[]> = {};

      // Add each tool category and its steps to the TOC
      let sectionCounter = 4;

      // Add Findings and Analysis section
      tableOfContents += `${sectionCounter}. [Findings and Analysis](#findings-and-analysis)\n`;

      // Add subsections for each tool category
      Object.entries(toolCategories).forEach(([tool, steps], toolIndex) => {
        const toolName = tool.charAt(0).toUpperCase() + tool.slice(1);
        tableOfContents += `   ${sectionCounter}.${toolIndex + 1}. [${toolName} Results](#${toolName.toLowerCase().replace(/\s+/g, '-')}-results)\n`;

        // Add individual steps as deeper subsections if there are multiple steps for this tool
        if (steps.length > 1) {
          steps.forEach((step, stepIndex) => {
            const stepTitle =
              step.description.length > 60
                ? step.description.substring(0, 60) + '...'
                : step.description;
            const anchorId = `step-${step.id}`;
            tableOfContents += `      ${sectionCounter}.${toolIndex + 1}.${stepIndex + 1}. [${stepTitle}](#${anchorId})\n`;
          });
        }
      });

      // Add conclusion and recommendations
      sectionCounter++;
      tableOfContents += `${sectionCounter}. [Conclusions](#conclusions)\n`;

      sectionCounter++;
      tableOfContents += `${sectionCounter}. [Recommendations](#recommendations)\n`;

      // Add appendices if there's research data
      if (this.researchData.length > 0) {
        sectionCounter++;
        tableOfContents += `${sectionCounter}. [Appendices](#appendices)\n`;
        tableOfContents += `   ${sectionCounter}.1. [Raw Data](#raw-data)\n`;
        tableOfContents += `   ${sectionCounter}.2. [Resource Links](#resource-links)\n`;
      }

      this.spinner.succeed(chalk.green('Table of contents generated'));
      return tableOfContents;
    } catch (error) {
      this.spinner.fail(chalk.red('Failed to generate table of contents'));
      console.error(error);
      return `# ${this.task}\n\n## Table of Contents\n\n1. [Executive Summary](#executive-summary)\n2. [Findings](#findings)\n3. [Conclusions](#conclusions)\n`;
    }
  }

  private async generateReport(): Promise<void> {
    this.spinner.start(chalk.blue('Generating final report...'));

    try {
      // Generate table of contents first
      const tableOfContents = this.generateTableOfContents();

      // Generate report content using LLM
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
          
          TABLE OF CONTENTS:
          ${tableOfContents}
          
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
          7. Ensure all anchor IDs match exactly what's in the table of contents for proper navigation`,
        },
      ];

      const reportContent = await getReasoningCompletion(reportPrompt);

      // Combine TOC with report content
      const fullReport = `${tableOfContents}\n\n---\n\n${reportContent}`;

      // Save as markdown
      const timestamp = Date.now();
      const markdownFilename = `report-${timestamp}.md`;
      await this.tools.fileOperations.writeFile(markdownFilename, fullReport);

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
          ${fullReport}
          
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
          10. Ensure the page is self-contained with all needed scripts and styles`,
        },
      ];

      const htmlContent = await getChatCompletion(htmlPrompt);

      const htmlFilename = `report-${timestamp}.html`;
      await this.tools.fileOperations.writeFile(htmlFilename, htmlContent);

      this.spinner.succeed(chalk.green('HTML report generated'));

      // Generate basic HTML preview for the console
      const htmlPreview = marked(reportContent);

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
