import { z } from 'zod';
import { Tool } from '../types';
import { Stagehand } from '@browserbasehq/stagehand';
import { CoreMessage, generateObject, generateText, UserContent } from 'ai';
import { openai } from '@ai-sdk/openai';
import { chromium } from '@playwright/test';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export const BrowserSchema = z.object({
  url: z.string().url().optional(),
  goal: z.string().describe('The goal of the browsing session'),
});

type AtomicMethod =
  | 'GOTO'
  | 'ACT'
  | 'EXTRACT'
  | 'OBSERVE'
  | 'CLOSE'
  | 'SCREENSHOT'
  | 'WAIT'
  | 'NAVBACK'
  | 'HTML'
  | 'AI_HANDLE';

type Step = {
  text: string;
  reasoning: string;
  method: AtomicMethod;
  instruction?: string;
  result?: any;
  timestamp?: string;
  url?: string;
};

type ExtractedData = {
  type: string;
  content: any;
  metadata?: Record<string, any>;
};

type BrowserResult = {
  message: string;
  steps: Step[];
  totalSteps: number;
  results: ExtractedData[];
  summary?: string;
};

/**
 * Tool for browsing websites and extracting information
 */
export class BrowserTool implements Tool {
  name = 'browser';
  description = 'Browse websites and extract information';
  schema = BrowserSchema;
  private browserInstalled = false;
  private activeConnections = 0;

  // Singleton pattern for browser instance
  private static browserInstance: Stagehand | null = null;
  private static isBrowserInitializing = false;
  private static initPromise: Promise<Stagehand> | null = null;
  private static isRegisteredForExit = false;

  constructor() {
    // Register exit handlers when the class is instantiated
    this.registerExitHandlers();
  }

  /**
   * Register process exit handlers to ensure browser is properly closed
   */
  private registerExitHandlers(): void {
    // Only register once
    if (BrowserTool.isRegisteredForExit) return;

    // Handle normal exit
    process.on('exit', () => {
      this.closeBrowserSync();
    });

    // Handle Ctrl+C
    process.on('SIGINT', async () => {
      console.log('Received SIGINT, closing browser...');
      await this.closeBrowser();
      process.exit(0);
    });

    // Handle termination
    process.on('SIGTERM', async () => {
      console.log('Received SIGTERM, closing browser...');
      await this.closeBrowser();
      process.exit(0);
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', async (error) => {
      console.error('Uncaught exception:', error);
      await this.closeBrowser();
      process.exit(1);
    });

    BrowserTool.isRegisteredForExit = true;
  }

  /**
   * Execute the browser tool
   */
  async execute(args: z.infer<typeof BrowserSchema>): Promise<BrowserResult> {
    // Ensure browsers are installed
    await this.ensureBrowsersInstalled();

    console.log('Executing browser tool', JSON.stringify(args, null, 2));

    const { url, goal } = args;

    try {
      // Increment active connections counter
      this.activeConnections++;

      // Get or create a browser instance
      const browser = await this.getBrowserInstance();

      // Execute the task with optimized steps
      return await this.executeWithOptimizedSteps(browser, goal, url);
    } finally {
      // Decrement active connections counter
      this.activeConnections--;

      // If no active connections and not keeping browser alive, close it
      if (
        this.activeConnections === 0 &&
        process.env.KEEP_BROWSER_ALIVE !== 'true'
      ) {
        await this.closeBrowser();
      }
    }
  }

  /**
   * Check and install browser dependencies if needed
   */
  private async ensureBrowsersInstalled(): Promise<void> {
    if (this.browserInstalled) return;

    try {
      // Try to launch a browser to check if it's installed
      const browser = await chromium.launch({ headless: true });
      await browser.close();
      this.browserInstalled = true;
    } catch (error) {
      console.log('Installing browsers for Playwright...');
      try {
        // Try to install the browsers
        await execAsync('npx playwright install chromium');
        console.log('Browser installation complete');
        this.browserInstalled = true;
      } catch (installError) {
        console.error('Failed to install browsers:', installError);
        throw new Error(
          'Failed to install required browsers. Please run "npx playwright install" manually.',
        );
      }
    }
  }

  /**
   * Get or create a shared browser instance
   */
  private async getBrowserInstance(): Promise<Stagehand> {
    // Return existing instance if available
    if (BrowserTool.browserInstance) {
      return BrowserTool.browserInstance;
    }

    // Wait for initialization if in progress
    if (BrowserTool.isBrowserInitializing && BrowserTool.initPromise) {
      return BrowserTool.initPromise;
    }

    // Initialize new browser
    BrowserTool.isBrowserInitializing = true;
    BrowserTool.initPromise = (async () => {
      const stagehand = new Stagehand({
        env: 'LOCAL',
        headless: process.env.HEADLESS !== 'false', // Use env var to control headless mode
        logger: () => {}, // Disable logging for better performance
        enableCaching: true,
      });

      try {
        await stagehand.init();
        BrowserTool.browserInstance = stagehand;
        return stagehand;
      } catch (error) {
        // Reset flags if initialization fails
        BrowserTool.isBrowserInitializing = false;
        BrowserTool.initPromise = null;
        throw error;
      }
    })();

    return BrowserTool.initPromise;
  }

  /**
   * Close the browser instance properly
   */
  private async closeBrowser(): Promise<void> {
    if (BrowserTool.browserInstance) {
      console.log('Closing browser instance...');
      try {
        await BrowserTool.browserInstance.close();
      } catch (error) {
        console.error('Error closing browser:', error);
      } finally {
        // Reset all browser-related state
        BrowserTool.browserInstance = null;
        BrowserTool.isBrowserInitializing = false;
        BrowserTool.initPromise = null;
      }
    }
  }

  /**
   * Synchronous close for exit handlers
   */
  private closeBrowserSync(): void {
    if (BrowserTool.browserInstance) {
      try {
        // Force close any browser windows in a way that doesn't use async/await
        // This is needed for the process.on('exit') handler
        const browser = BrowserTool.browserInstance;
        if (browser && browser.page) {
          browser.page.close();
        }
      } catch (e) {
        // Ignore errors during forced close
      }

      // Reset browser instance
      BrowserTool.browserInstance = null;
    }
  }

  /**
   * Execute a browsing task with optimized steps
   */
  private async executeWithOptimizedSteps(
    browser: Stagehand,
    goal: string,
    providedUrl?: string,
  ): Promise<BrowserResult> {
    // Use a lower default max steps for faster completion
    const MAX_STEPS = parseInt(process.env.MAX_STEPS || '5');
    const MAX_SIMILAR_STEPS = 3;

    let similarStepsCount = 0;
    let lastAction = '';
    let previousSteps: Step[] = [];
    let stepCount = 0;
    let results: ExtractedData[] = [];

    try {
      console.log(`Breaking down goal: "${goal}" into atomic steps...`);

      // First step is navigation if URL is provided
      if (providedUrl) {
        // Create first step
        const firstStep: Step = {
          text: `Navigating to ${providedUrl}`,
          reasoning: goal,
          method: 'GOTO',
          instruction: providedUrl,
        };

        // Execute navigation with optimized loading
        console.log(`Executing step 1: ${firstStep.text}`);
        await this.runAtomicStep(browser, 'GOTO', providedUrl, {
          waitUntil: 'domcontentloaded', // Faster than networkidle
          timeout: 30000, // Shorter timeout
        });

        previousSteps = [firstStep];
        stepCount = 1;

        // Try to extract data immediately for simple goals
        if (this.isSimpleExtractionGoal(goal)) {
          const quickExtraction = await this.quickExtract(browser, goal);
          if (quickExtraction) {
            console.log('Successfully extracted data in one step');

            results.push({
              type: 'extract',
              content: quickExtraction,
              metadata: {
                tool: 'EXTRACT',
                instruction: goal,
                timestamp: new Date().toISOString(),
              },
            });

            // Generate summary and return results
            const summary = await this.generateSummary(results, goal);

            return {
              message: 'Task completed successfully with optimized extraction',
              steps: previousSteps,
              totalSteps: 1,
              results,
              summary,
            };
          }
        }
      }

      // Step by step execution for more complex goals
      while (stepCount < MAX_STEPS) {
        stepCount++;

        // Take screenshot only every other step to reduce overhead
        const shouldTakeScreenshot = stepCount % 2 === 0;

        // Get next step with optimized prompt
        const nextStep = await this.determineNextStep(
          browser,
          goal,
          previousSteps,
          shouldTakeScreenshot,
        );

        // Add to previous steps
        previousSteps.push(nextStep);

        // Check for completion
        if (nextStep.method === 'CLOSE') {
          console.log('Goal completion detected, finishing task');
          break;
        }

        // Add timestamp and URL
        nextStep.timestamp = new Date().toISOString();
        try {
          nextStep.url = await browser.page.url();
        } catch (error) {
          // Ignore URL errors
        }

        console.log(
          `Executing step ${stepCount}: ${nextStep.text} (${nextStep.method})`,
        );

        // Handle AI_HANDLE separately (no browser interaction needed)
        if (nextStep.method === 'AI_HANDLE') {
          try {
            const aiResult = await this.processWithAI(
              nextStep.instruction || '',
            );

            results.push({
              type: 'ai_analysis',
              content: aiResult,
              metadata: {
                tool: 'AI_HANDLE',
                instruction: nextStep.instruction,
                timestamp: new Date().toISOString(),
              },
            });

            continue;
          } catch (error) {
            console.error('AI processing error:', error);
          }
        }

        // Loop detection
        const currentAction = `${nextStep.method}:${nextStep.instruction}`;
        if (currentAction === lastAction) {
          similarStepsCount++;
          if (similarStepsCount >= MAX_SIMILAR_STEPS) {
            console.warn(
              `Loop detected - same action repeated ${MAX_SIMILAR_STEPS} times`,
            );
            break;
          }
        } else {
          similarStepsCount = 0;
          lastAction = currentAction;
        }

        // Execute the step
        try {
          nextStep.result = await this.runAtomicStep(
            browser,
            nextStep.method,
            nextStep.instruction,
          );

          // Process and store extraction results
          if (nextStep.method === 'EXTRACT' || nextStep.method === 'HTML') {
            // Truncate large results for logging
            const resultPreview =
              typeof nextStep.result === 'string'
                ? nextStep.result.length > 100
                  ? nextStep.result.substring(0, 100) + '...'
                  : nextStep.result
                : 'Data extracted';

            console.log(`Extracted: ${resultPreview}`);

            const processedData = this.processExtractedData(
              nextStep.result,
              nextStep.method as 'EXTRACT' | 'HTML',
              nextStep.instruction || '',
            );

            results.push(processedData);

            // Check if we can exit early with sufficient data
            if (await this.isDataSufficient(results, goal)) {
              console.log('Sufficient data collected, completing task');
              break;
            }
          }
        } catch (error) {
          console.error(`Error executing step: ${error}`);
          // Continue to next step instead of failing completely
        }
      }

      // Generate summary
      const summary = await this.generateSummary(results, goal);

      // Return results
      return {
        message:
          stepCount >= MAX_STEPS
            ? `Task terminated after reaching maximum steps (${MAX_STEPS})`
            : similarStepsCount >= MAX_SIMILAR_STEPS
              ? 'Task terminated after detecting repetitive actions'
              : 'Task completed successfully',
        steps: previousSteps,
        totalSteps: stepCount,
        results,
        summary,
      };
    } catch (error) {
      console.error('Browser execution error:', error);
      return {
        message: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        steps: previousSteps,
        totalSteps: stepCount,
        results,
      };
    }
  }

  /**
   * Determine if a goal is a simple extraction
   */
  private isSimpleExtractionGoal(goal: string): boolean {
    const simplePatterns = [
      'extract',
      'find',
      'get',
      'what is',
      'show me',
      'tell me about',
      'price',
      'title',
      'heading',
      'summary',
    ];

    const goalLower = goal.toLowerCase();
    return simplePatterns.some((pattern) => goalLower.includes(pattern));
  }

  /**
   * Attempt a quick extraction without multi-step planning
   */
  private async quickExtract(
    browser: Stagehand,
    goal: string,
  ): Promise<string | null> {
    try {
      // Get page content with minimal processing
      const content = await browser.page.content();
      const title = await browser.page.title();
      const url = await browser.page.url();

      // Create a minimal prompt for extraction
      const prompt = `
URL: ${url}
Title: ${title}
Goal: ${goal}

Please extract the requested information directly from this HTML content.
Provide ONLY the extracted information without any additional context, explanation, or formatting.

HTML content (excerpt): ${content.substring(0, 5000)}...
`;

      // Extract using AI
      const result = await this.processWithAI(prompt);

      // If result is too long or appears to be prose instead of extracted data, reject
      if (result.length > 1000 || result.split('\n').length > 10) {
        return null;
      }

      return result;
    } catch (error) {
      console.error('Quick extraction error:', error);
      return null;
    }
  }

  /**
   * Determine the next step with optimized prompting
   */
  private async determineNextStep(
    browser: Stagehand,
    goal: string,
    previousSteps: Step[],
    takeScreenshot: boolean,
  ): Promise<Step> {
    // Get current URL
    let currentUrl = '';
    try {
      currentUrl = await browser.page.url();
    } catch (error) {
      // Ignore URL errors
    }

    // Prepare minimal context - only use the last 2 steps to reduce token usage
    const recentSteps = previousSteps.slice(-2);
    const hasResults = recentSteps.some((step) => step.result);

    // Create concise prompt
    const content: UserContent = [
      {
        type: 'text',
        text: `URL: ${currentUrl}
Goal: "${goal}"

${hasResults ? 'Previous steps have collected data. If the goal is achieved, use CLOSE method to finish.' : ''}

Determine the next action to take.

Available methods:
- EXTRACT: Get specific data from the page (provide clear extraction instructions)
- ACT: Click, type, or interact with the page (provide exact element or action)
- HTML: Get the page source for analysis
- OBSERVE: Analyze visible page elements
- AI_HANDLE: Process data without browser interaction
- CLOSE: Finish the task (use when done)

Keep actions atomic and focused on a single step.`,
      },
    ];

    // Add screenshot only every other step
    if (takeScreenshot) {
      try {
        // Use compressed JPEG for smaller payload
        const screenshot = await browser.page.screenshot({
          type: 'jpeg',
          quality: 50,
          fullPage: false,
        });

        content.push({
          type: 'image',
          image: Buffer.from(screenshot).toString('base64'),
        });
      } catch (error) {
        // Ignore screenshot errors
      }
    }

    // Add latest result if available
    const latestStep = previousSteps[previousSteps.length - 1];
    if (latestStep?.result) {
      const resultPreview =
        typeof latestStep.result === 'string'
          ? latestStep.result.length > 200
            ? latestStep.result.substring(0, 200) + '...'
            : latestStep.result
          : JSON.stringify(latestStep.result).substring(0, 200) + '...';

      content.push({
        type: 'text',
        text: `Latest result: ${resultPreview}`,
      });
    }

    // Generate next step with focused prompt
    const result = await generateObject({
      model: openai('gpt-4o-mini'), // Use smaller model for better performance
      schema: z.object({
        text: z.string(),
        reasoning: z.string(),
        method: z.enum([
          'GOTO',
          'ACT',
          'EXTRACT',
          'OBSERVE',
          'CLOSE',
          'SCREENSHOT',
          'WAIT',
          'NAVBACK',
          'HTML',
          'AI_HANDLE',
        ]),
        instruction: z.string().optional(),
      }),
      messages: [{ role: 'user', content }],
    });

    return result.object;
  }

  /**
   * Execute an atomic browser step
   */
  private async runAtomicStep(
    browser: Stagehand,
    method: AtomicMethod,
    instruction?: string,
    options?: any,
  ): Promise<any> {
    const page = browser.page;

    try {
      switch (method) {
        case 'GOTO':
          await page.goto(
            instruction!,
            options || {
              waitUntil: 'domcontentloaded', // Faster than networkidle
              timeout: 30000,
            },
          );
          break;

        case 'ACT':
          await page.act(instruction!);
          break;

        case 'EXTRACT': {
          if (!instruction) {
            throw new Error('EXTRACT method requires an instruction');
          }

          // Extract with minimal context
          const html = await page.content();

          // Limit HTML content size for token efficiency
          const truncatedHtml =
            html.length > 15000 ? html.substring(0, 15000) + '...' : html;

          // Process with AI using a focused prompt
          const extractedData = await this.processWithAI(
            `Extract the following from this page: ${instruction}\n\nHTML content:\n${truncatedHtml}\n\nProvide ONLY the extracted information without explanations.`,
          );

          return extractedData;
        }

        case 'OBSERVE':
          return await page.observe({
            instruction,
            onlyVisible: true, // Faster with only visible elements
          });

        case 'CLOSE':
          // No action needed, just a signal to end
          break;

        case 'SCREENSHOT': {
          // Optimize for smaller size
          const screenshotBuffer = await page.screenshot({
            type: 'jpeg',
            quality: 70,
            fullPage: false,
          });
          return Buffer.from(screenshotBuffer).toString('base64');
        }

        case 'WAIT':
          // Limit max wait time
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(Number(instruction) || 1000, 5000)),
          );
          break;

        case 'NAVBACK':
          await page.goBack();
          break;

        case 'HTML':
          // Get HTML with size limit
          const fullHtml = await page.content();
          return fullHtml.length > 100000
            ? fullHtml.substring(0, 100000) + '...'
            : fullHtml;

        default:
          throw new Error(`Unsupported method: ${method}`);
      }
    } catch (error) {
      console.error(`Error in ${method}:`, error);
      throw error;
    }
  }

  /**
   * Process extracted data into a standard format
   */
  private processExtractedData(
    data: any,
    tool: 'EXTRACT' | 'HTML',
    instruction: string,
  ): ExtractedData {
    // Convert data to processable format
    let processableData = data;

    if (
      typeof data !== 'string' &&
      typeof data !== 'number' &&
      typeof data !== 'boolean'
    ) {
      try {
        processableData = JSON.stringify(data);
      } catch (e) {
        processableData = String(data);
      }
    }

    // Truncate large data
    if (typeof processableData === 'string' && processableData.length > 50000) {
      processableData = processableData.substring(0, 50000) + '... [truncated]';
    }

    return {
      type: tool.toLowerCase(),
      content: processableData,
      metadata: {
        tool,
        instruction,
        timestamp: new Date().toISOString(),
      },
    };
  }

  /**
   * Check if collected data is sufficient for the goal
   */
  private async isDataSufficient(
    results: ExtractedData[],
    goal: string,
  ): Promise<boolean> {
    if (results.length === 0) return false;

    // Only use for tasks with multiple data points
    if (results.length >= 2) {
      const message: CoreMessage = {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Goal: "${goal}"\nNumber of data points: ${results.length}\nLast data type: ${results[results.length - 1].type}\n\nBased only on this information, is the goal likely complete? Answer with just 'yes' or 'no'.`,
          },
        ],
      };

      const response = await generateText({
        model: openai('gpt-4o-mini'),
        messages: [message],
      });

      return response.text.toLowerCase().includes('yes');
    }

    return false;
  }

  /**
   * Generate a summary of the results
   */
  private async generateSummary(
    results: ExtractedData[],
    goal: string,
  ): Promise<string> {
    if (results.length === 0) {
      return 'No data was extracted during this task.';
    }

    // Prepare minimal content
    const content = results.map((result) => {
      // Simplify content to reduce token usage
      let simplifiedContent: any;

      if (typeof result.content === 'string') {
        // Truncate strings
        simplifiedContent =
          result.content.length > 500
            ? result.content.substring(0, 500) + '... [truncated]'
            : result.content;
      } else {
        // For objects, convert to string and truncate
        try {
          const contentStr = JSON.stringify(result.content);
          simplifiedContent =
            contentStr.length > 500
              ? contentStr.substring(0, 500) + '... [truncated]'
              : contentStr;
        } catch (e) {
          simplifiedContent = '[Complex object]';
        }
      }

      return {
        type: result.type,
        content: simplifiedContent,
        instruction: result.metadata?.instruction,
      };
    });

    // Generate concise summary
    const message: CoreMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Goal: "${goal}"\n\nExtracted data (${results.length} items): ${JSON.stringify(content)}\n\nProvide a concise 1-3 sentence summary of the findings.`,
        },
      ],
    };

    const response = await generateText({
      model: openai('gpt-4o-mini'),
      messages: [message],
    });

    return response.text;
  }

  /**
   * Process data with AI
   */
  private async processWithAI(instruction: string): Promise<string> {
    // Truncate long instructions
    const truncatedInstruction =
      instruction.length > 2000
        ? instruction.substring(0, 2000) + '... [truncated]'
        : instruction;

    // Generate text with minimal context
    const response = await generateText({
      model: openai('gpt-4o-mini'),
      messages: [
        {
          role: 'user',
          content: truncatedInstruction,
        },
      ],
    });

    return response.text;
  }

  /**
   * Clean up resources and properly close the browser
   */
  async cleanup() {
    await this.closeBrowser();
  }
}

export const browserTool = new BrowserTool();
