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
import path from 'path';
import {
  createTaskFolder,
  createTodoMd,
  updateSubtaskStatus,
  addSubtask,
  addReasoningToTodo,
} from '../tools/file';

interface SubTask {
  id: number;
  description: string;
  status: 'pending' | 'completed';
}

export class Agent {
  private task: string;
  private maxSteps: number = 20;
  private currentStep: number = 0;
  private tools: Record<string, any>;
  private researchData: any[] = [];
  private spinner: any;
  private defaultModel: string;
  private taskTimestamp: number;
  private taskFolderPath: string = '';
  private todoMdPath: string = '';
  private subtasks: SubTask[] = [];

  constructor(options: AgentOptions) {
    this.task = options.task;
    this.maxSteps = options.maxSteps || this.maxSteps;
    this.tools = tools;
    this.spinner = ora();
    this.defaultModel = process.env.DEFAULT_LLM_MODEL || 'gpt-4o';
    this.taskTimestamp = Date.now();
  }

  async run(): Promise<void> {
    console.log(`Agent started for task: ${this.task}`);

    // Initialize task environment
    await this.initializeTaskEnvironment();

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
          // Update todo.md with completion status
          await addReasoningToTodo(
            this.todoMdPath,
            `Task completed: ${nextStep.reason}`,
          );
          break;
        }

        // Execute the determined step
        await this.executeStep(nextStep.step);

        // Update subtask status in todo.md
        if (nextStep.step.subtaskId) {
          await updateSubtaskStatus(
            this.todoMdPath,
            nextStep.step.subtaskId,
            'completed',
          );
        }

        // Add reasoning about what to do next
        if (nextStep.reason) {
          await addReasoningToTodo(this.todoMdPath, nextStep.reason);
        }
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

  private async initializeTaskEnvironment(): Promise<void> {
    this.spinner.start(chalk.blue('Initializing task environment...'));

    try {
      // Create task folder
      this.taskFolderPath = await createTaskFolder(this.taskTimestamp);

      // Plan the task and create subtasks
      const plan = await this.createTaskPlan();

      // Create todo.md with the planned subtasks
      const todoResult = await createTodoMd(
        this.taskFolderPath,
        this.task,
        plan.subtasks.map((st) => ({
          description: st.description,
          status: 'pending',
        })),
      );

      if (todoResult.success) {
        this.todoMdPath = todoResult.data as string;
        this.subtasks = plan.subtasks;
      } else {
        throw new Error(`Failed to create todo.md: ${todoResult.message}`);
      }

      this.spinner.succeed(chalk.green('Task environment initialized'));
      console.log(chalk.yellow(`Task folder: ${this.taskFolderPath}`));
      console.log(chalk.yellow(`Todo file: ${this.todoMdPath}`));
    } catch (error) {
      this.spinner.fail(chalk.red('Failed to initialize task environment'));
      console.error(error);
      throw error;
    }
  }

  private async createTaskPlan(): Promise<{ subtasks: SubTask[] }> {
    this.spinner.start(chalk.blue('Creating task plan...'));

    try {
      // Use LLM to create a plan with subtasks
      const { object } = await generateObject({
        model: openai(this.defaultModel),
        system: `You are a strategic planning assistant that breaks down complex tasks into smaller, manageable subtasks. Be specific and detailed.`,
        schema: z.object({
          subtasks: z.array(
            z.object({
              id: z.number(),
              description: z.string(),
              status: z.enum(['pending', 'completed']).default('pending'),
            }),
          ),
        }),
        prompt: `Break down the following task into 5-10 clear subtasks: "${this.task}"
        
        For each subtask:
        1. Make it specific and actionable
        2. Ensure it contributes to the overall task
        3. Order subtasks logically (earlier tasks should support later ones)
        4. Assign an ID number to each subtask
        
        Provide your response as a structured list of subtasks.`,
      });

      this.spinner.succeed(chalk.green('Task plan created'));

      return {
        subtasks: object.subtasks,
      };
    } catch (error) {
      this.spinner.fail(chalk.red('Failed to create task plan'));
      console.error(error);
      throw error;
    }
  }

  private async determineNextStep(): Promise<{
    step: Step & { subtaskId?: number };
    isComplete: boolean;
    reason?: string;
  }> {
    this.spinner.start(chalk.blue('Determining next step...'));

    try {
      // Get context from previous steps and todo.md
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
              subtaskId: z.number().optional(),
            })
            .optional(),
        }),
        prompt: `You are a strategic planning assistant that determines the next step in a complex task.

        OVERALL TASK: "${this.task}"
        
        CURRENT PROGRESS:
        ${previousStepsContext}
        
        SUBTASKS:
        ${this.subtasks.map((st) => `${st.id}. [${st.status === 'completed' ? 'x' : ' '}] ${st.description}`).join('\n')}
        
        AVAILABLE TOOLS:
        - search: For web search operations
        - browser: For web browsing, navigating pages, and extracting information
        - fileOperations: For reading, writing, or manipulating files
        - javascriptExecutor: For running JavaScript code
        
        DETERMINE THE NEXT STEP:
        1. Analyze the current progress and the overall task
        2. Decide if the task is complete or what needs to be done next
        3. If the task is not complete, select the next appropriate subtask from the list
        4. Provide a specific, actionable next step to complete that subtask
        5. Consider which tool would be most appropriate for this step
        
        If you determine the task is complete, set isComplete to true and explain why in the reason field.
        If more work is needed, set isComplete to false, provide the next step details, and explain your reasoning.
        Include the subtaskId for the subtask this step contributes to completing.`,
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
        const step: Step & { subtaskId?: number } = {
          id: this.currentStep,
          description:
            object.step?.description || 'Error: No step description provided',
          status: 'pending',
          params: object.step?.params || {},
          subtaskId: object.step?.subtaskId,
        };

        console.log(chalk.yellow('\nNext step:'));
        console.log(chalk.cyan(`${step.id}. ${step.description}`));

        // If this step completes a subtask, note which one
        if (step.subtaskId) {
          const subtask = this.subtasks.find((st) => st.id === step.subtaskId);
          if (subtask) {
            console.log(
              chalk.gray(
                `Contributing to subtask ${step.subtaskId}: ${subtask.description}`,
              ),
            );
          }
        }

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

  private async executeStep(
    step: Step & { subtaskId?: number },
  ): Promise<void> {
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

        terminal: {
          description:
            'Execute shell commands in the system terminal with safety restrictions',
          parameters: z.object({
            command: z.string().describe('Shell command to execute'),
            workingDir: z
              .string()
              .optional()
              .describe('Working directory for command execution'),
            timeout: z.number().optional().describe('Timeout in milliseconds'),
          }),
          execute: async (params: {
            command: string;
            workingDir?: string;
            timeout?: number;
          }) => {
            // Safety checks
            const commandStr = params.command.toLowerCase();
            const dangerousCommands = [
              'rm -rf',
              'mkfs',
              'dd',
              ':(){',
              'chmod -R',
              '> /dev/',
              '| passwd',
            ];

            if (dangerousCommands.some((cmd) => commandStr.includes(cmd))) {
              return {
                success: false,
                output: '',
                error: 'Potentially dangerous command blocked for safety',
                exitCode: -1,
              };
            }

            // Ensure working directory is confined to the task folder or safe locations
            const workingDir = params.workingDir || this.taskFolderPath;
            const absoluteWorkingDir = path.resolve(workingDir);

            // Check if the working directory is within safe boundaries
            if (
              !absoluteWorkingDir.startsWith(process.cwd()) &&
              !absoluteWorkingDir.startsWith('/tmp/') &&
              !absoluteWorkingDir.startsWith(path.resolve(this.taskFolderPath))
            ) {
              return {
                success: false,
                output: '',
                error: `Working directory not allowed: ${absoluteWorkingDir}`,
                exitCode: -1,
              };
            }

            try {
              return await this.tools.terminal.execute({
                ...params,
                workingDir: absoluteWorkingDir,
              });
            } catch (error: any) {
              return {
                success: false,
                output: '',
                error: `Terminal execution error: ${error.message}`,
                exitCode: -1,
              };
            }
          },
        },

        javascriptExecutor: {
          description: 'Execute JavaScript code',
          parameters: z.object({
            code: z.string().describe('JavaScript code to execute'),
          }),
          execute: async ({ code }: { code: string }) => {
            return await this.tools.javascriptExecutor.execute({ code });
          },
        },

        taskFileOperations: {
          description: 'Perform file operations within the task folder',
          parameters: z.object({
            operation: z.enum(['read', 'write', 'append']),
            filename: z.string().describe('Filename within the task folder'),
            content: z
              .string()
              .optional()
              .describe('Content to write (for write or append operation)'),
          }),
          execute: async ({
            operation,
            filename,
            content,
          }: {
            operation: 'read' | 'write' | 'append';
            filename: string;
            content?: string;
          }) => {
            // Ensure the file path is within the task folder
            const filePath = path.join(this.taskFolderPath, filename);

            try {
              if (operation === 'write' && content) {
                return await this.tools.fileOperations.writeFile(
                  filePath,
                  content,
                );
              } else if (operation === 'read') {
                return await this.tools.fileOperations.readFile(filePath);
              } else if (operation === 'append' && content) {
                // First read the file content
                const existingContent = await this.tools.fileOperations
                  .readFile(filePath)
                  .catch(() => ''); // Empty string if file doesn't exist

                // Then write back with appended content
                return await this.tools.fileOperations.writeFile(
                  filePath,
                  existingContent + content,
                );
              }
              return { success: false, message: 'Invalid operation' };
            } catch (error: any) {
              return {
                success: false,
                message: `File operation error: ${error.message}`,
              };
            }
          },
        },

        todoOperations: {
          description: 'Perform operations on the todo.md file',
          parameters: z.object({
            operation: z.enum(['updateSubtask', 'addSubtask', 'addReasoning']),
            subtaskId: z
              .number()
              .optional()
              .describe('ID of the subtask to update'),
            status: z
              .enum(['pending', 'completed'])
              .optional()
              .describe('New status for the subtask'),
            description: z
              .string()
              .optional()
              .describe('Description for a new subtask'),
            reasoning: z.string().optional().describe('Reasoning text to add'),
          }),
          execute: async (params: {
            operation: 'updateSubtask' | 'addSubtask' | 'addReasoning';
            subtaskId?: number;
            status?: 'pending' | 'completed';
            description?: string;
            reasoning?: string;
          }) => {
            try {
              switch (params.operation) {
                case 'updateSubtask':
                  if (params.subtaskId !== undefined && params.status) {
                    const result = await updateSubtaskStatus(
                      this.todoMdPath,
                      params.subtaskId,
                      params.status,
                    );

                    if (result.success && params.status === 'completed') {
                      // Update our internal tracking
                      const subtask = this.subtasks.find(
                        (st) => st.id === params.subtaskId,
                      );
                      if (subtask) {
                        subtask.status = 'completed';
                      }
                    }

                    return result;
                  }
                  return {
                    success: false,
                    message: 'Missing subtaskId or status',
                  };

                case 'addSubtask':
                  if (params.description) {
                    const result = await addSubtask(
                      this.todoMdPath,
                      params.description,
                    );

                    if (result.success) {
                      // Add to our internal tracking
                      const newSubtaskData = result.data as {
                        subtaskIndex: number;
                        description: string;
                      };
                      const newSubtask: SubTask = {
                        id: newSubtaskData.subtaskIndex,
                        description: newSubtaskData.description,
                        status: 'pending',
                      };
                      this.subtasks.push(newSubtask);
                    }

                    return result;
                  }
                  return { success: false, message: 'Missing description' };

                case 'addReasoning':
                  if (params.reasoning) {
                    return await addReasoningToTodo(
                      this.todoMdPath,
                      params.reasoning,
                    );
                  }
                  return { success: false, message: 'Missing reasoning text' };

                default:
                  return { success: false, message: 'Invalid operation' };
              }
            } catch (error: any) {
              return {
                success: false,
                message: `Todo operation error: ${error.message}`,
              };
            }
          },
        },
      };

      // Use LLM to determine which tool to use and how to use it
      const result = await generateText({
        model: openai(this.defaultModel),
        tools: aiTools,
        prompt:
          getSystemPrompt(this.task) +
          `\n\nCurrent step: ${step.description}\nStep parameters: ${JSON.stringify(step.params || {})}\n\nPrevious steps results: ${previousStepsContext}\n\nTask folder path: ${this.taskFolderPath}\nTodo.md path: ${this.todoMdPath}\n\nUse the appropriate tool to complete this step. Be precise and thorough.`,
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
            const researchEntry = {
              type: toolCall.toolName,
              stepId: step.id,
              subtaskId: step.subtaskId,
              data: toolResult,
              timestamp: new Date().toISOString(),
            };

            this.researchData.push(researchEntry);

            // Store result in task folder too
            await this.tools.fileOperations.writeFile(
              path.join(this.taskFolderPath, `step-${step.id}-result.json`),
              JSON.stringify(researchEntry, null, 2),
            );
          }
        }
      }

      step.status = 'completed';

      console.log(chalk.green(`Completed step: ${step.description}`));

      // Update subtask status if this step completed a subtask
      if (step.subtaskId) {
        const subtask = this.subtasks.find((st) => st.id === step.subtaskId);
        if (subtask) {
          subtask.status = 'completed';
          await updateSubtaskStatus(
            this.todoMdPath,
            step.subtaskId,
            'completed',
          );
          console.log(
            chalk.green(
              `Completed subtask ${step.subtaskId}: ${subtask.description}`,
            ),
          );
        }
      }
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
      context += `Step ${data.stepId}`;

      if (data.subtaskId) {
        const subtask = this.subtasks.find((st) => st.id === data.subtaskId);
        if (subtask) {
          context += ` (Subtask ${data.subtaskId}: ${subtask.description})`;
        }
      }

      context += `: ${data.type} operation\n`;
      context += `Results:\n${JSON.stringify(data.data, null, 2)}\n\n`;
    });

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
          ${JSON.stringify(
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
              subtaskId: data.subtaskId,
            })),
            null,
            2,
          )}
          
          SUBTASKS:
          ${JSON.stringify(this.subtasks, null, 2)}
          
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
      const markdownFilename = path.join(this.taskFolderPath, `report.md`);
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

      const htmlFilename = path.join(this.taskFolderPath, `report.html`);
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
