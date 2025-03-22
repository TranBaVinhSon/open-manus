import { getChatCompletion } from '../llm';
import { tools } from '../tools';
import { AgentOptions, Step } from '../types';
import chalk from 'chalk';
import ora from 'ora';
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { z } from 'zod';
import { getSystemPrompt } from './prompts/system-prompt';
import { generateObject } from 'ai';
import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration';
import { ReportGenerator, ExecutionStats } from './report-generator';

dayjs.extend(duration);
import { getTaskPlanningPrompt } from './prompts/task-planning-prompt';
import { getGenerateAnswerPrompt } from './prompts/generate-answer-prompt';

export class Agent {
  private task: string;
  private maxSteps: number = 20;
  private currentStep: number = 0;
  private tools: Record<string, any>;
  private researchData: any[] = [];
  private spinner: ora.Ora;
  private defaultModel: string;
  private startTime: bigint;
  private taskPlanningModel: string;

  constructor(options: AgentOptions) {
    this.task = options.task;
    this.maxSteps = Number(process.env.MAX_STEPS) || this.maxSteps;
    this.tools = tools;
    this.spinner = ora();
    this.defaultModel = process.env.DEFAULT_LLM_MODEL || 'gpt-4o';
    this.startTime = process.hrtime.bigint();
    this.taskPlanningModel = process.env.TASK_PLANNING_MODEL || 'o3-mini';
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

    if (this.researchData.length > 0) {
      await this.generateReport();
    }
  }

  private async generateAnswer(): Promise<string> {
    const { text } = await generateText({
      model: openai(this.defaultModel),
      prompt: getGenerateAnswerPrompt(this.task, this.researchData),
    });

    return text;
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
        model: openai(this.taskPlanningModel, {
          structuredOutputs: false,
        }),
        system: getSystemPrompt(),
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
              id: z.number().describe('The step number'),
              description: z.string().describe('The next step to take'),
              status: z
                .string()
                .describe(
                  'The status of the step (pending, running, completed, or failed)',
                ),
            })
            .optional(),
        }),
        prompt: getTaskPlanningPrompt(this.task, previousStepsContext),
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
          description: this.tools.search.description,
          parameters: z.object({
            query: z.string().describe('The search query'),
            numberOfResults: z
              .number()
              .describe('The number of results to return')
              .optional(),
          }),

          execute: async (params: {
            query: string;
            numberOfResults?: number;
          }) => {
            const result = await this.tools.search.execute(params);
            return result;
          },
        },

        browser: {
          description: this.tools.browser.description,
          parameters: z.object({
            url: z
              .string()
              .url()
              .describe('The URL to visit to complete the task'),
            goal: z.string().describe('Goal of the browsing session'),
          }),
          execute: async (params: { url?: string; goal?: string }) => {
            const result = await this.tools.browser.execute(params);
            return result;
          },
        },

        fileOperations: {
          description: this.tools.fileOperations.description,
          parameters: z.object({
            operation: z.enum(['read', 'write', 'list']),
            filePath: z.string().describe('Path to the file or directory'),
            content: z
              .string()
              .optional()
              .describe('Content to write (for write operation)'),
            encoding: z
              .string()
              .optional()
              .default('utf8')
              .describe('File encoding'),
          }),
          execute: async (params: any) => {
            return await this.tools.fileOperations.execute(params);
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
          description: this.tools.javascriptExecutor.description,
          parameters: z.object({
            description: z
              .string()
              .describe(
                'Generate JavaScript code to complete the task, such as data calculation...etc and execute the code',
              ),
          }),
          execute: async (params: { description: string }) => {
            return await this.tools.javascriptExecutor.execute(params);
          },
        },
      };

      const result = await generateText({
        model: openai(this.defaultModel),
        tools: aiTools,
        prompt:
          getSystemPrompt(this.task) +
          `\n\nCurrent step: ${step.description}\n\nPrevious steps results: ${previousStepsContext}\n\nUse the appropriate tool to complete this step. Be precise and thorough.`,
        // maxSteps: 10,
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
      console.log(`research data`, JSON.stringify(this.researchData, null, 2));
    } catch (genTextError) {
      console.error('Error in generateText call:', genTextError);
      console.error('Error details:', JSON.stringify(genTextError, null, 2));
      throw genTextError;
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

  private calculateExecutionStats(): ExecutionStats {
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

  private async generateReport(): Promise<void> {
    console.log(chalk.blue('\nChecking if a detailed report is needed...'));
    const executionStats = this.calculateExecutionStats();

    const reportGenerator = new ReportGenerator({
      task: this.task,
      researchData: this.researchData,
      tools: this.tools,
      spinner: this.spinner,
      executionStats,
      model: this.defaultModel,
    });

    await reportGenerator.generateReport();
  }
}
