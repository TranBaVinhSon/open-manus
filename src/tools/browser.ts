import { z } from 'zod';
import { Tool } from '../types/agent';
// Remove the legacy import and use only the official package
import { Stagehand, ObserveResult } from '@browserbasehq/stagehand';
import * as cheerio from 'cheerio';
import { CoreMessage, generateObject, UserContent } from 'ai';
import { openai } from '@ai-sdk/openai';
// Add import for Playwright to handle browser installation
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
  | 'NAVBACK';

type Step = {
  text: string;
  reasoning: string;
  tool: AtomicMethod;
  instruction: string;
};

export class BrowserTool implements Tool {
  name = 'browser';
  description = 'Access and interact with web pages using a browser';
  schema = BrowserSchema;
  private browser: any = null;
  private browserInstalled = false;

  // Add a method to check and install browsers if needed
  private async ensureBrowsersInstalled(): Promise<void> {
    if (this.browserInstalled) return;

    try {
      // Try to launch a browser to check if it's installed
      const browser = await chromium.launch({ headless: false });
      await browser.close();
      this.browserInstalled = true;
    } catch (error) {
      console.log('Installing browsers for Playwright...');
      try {
        // Try to install the browsers
        const { stdout, stderr } = await execAsync(
          'npx playwright install chromium',
        );
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

  async execute(args: z.infer<typeof BrowserSchema>) {
    // Ensure browsers are installed before proceeding
    await this.ensureBrowsersInstalled();

    console.log('Executing browser tool', JSON.stringify(args, null, 2));

    const { url, goal } = args;

    // Break down the goal into atomic steps and execute them
    const result = await this.executeGoal(goal, url);
    return result;
  }

  // Main method to execute a goal by breaking it down into atomic steps
  private async executeGoal(goal: string, providedUrl?: string): Promise<any> {
    // Ensure browsers are installed before proceeding
    await this.ensureBrowsersInstalled();

    // Get maximum steps from environment variable with default fallback
    const MAX_STEPS = parseInt(process.env.MAX_STEPS || '20');
    // Add loop detection variables
    const MAX_SIMILAR_STEPS = 3;
    let similarStepsCount = 0;
    let lastAction = '';

    // Initialize a Stagehand instance for atomic operations
    const stagehandInstance = new Stagehand({
      env: 'LOCAL',
      headless: false,
      logger: () => {},
    });

    try {
      await stagehandInstance.init();
      console.log(`Breaking down goal: "${goal}" into atomic steps...`);

      // Step 1: Determine starting URL (use provided URL or select one)
      let startUrl: string;
      let startUrlReasoning: string;

      if (providedUrl) {
        startUrl = providedUrl;
        startUrlReasoning = 'Using the URL provided in the request';
      } else {
        // Select starting URL using LLM
        const result = await this.selectStartingUrl(goal);
        startUrl = result.url;
        startUrlReasoning = result.reasoning;
      }

      console.log(`Starting URL: ${startUrl} (Reason: ${startUrlReasoning})`);

      // First step is always navigation to the starting URL
      const firstStep: Step = {
        text: `Navigating to ${startUrl}`,
        reasoning: startUrlReasoning,
        tool: 'GOTO',
        instruction: startUrl,
      };

      // Execute first step: navigate
      console.log(`Executing step 1: ${firstStep.text}`);
      await this.runAtomicStep(stagehandInstance, 'GOTO', startUrl);

      let previousSteps: Step[] = [firstStep];
      let extraction: string | undefined = undefined;
      let stepCount = 1;
      let goalCompleted = false;
      // Initialize results collection
      let results: any[] = [];

      // Step 2+: Iteratively determine and execute next steps until goal is complete or MAX_STEPS reached
      while (true) {
        stepCount++;

        // Check if we've reached the maximum number of steps
        if (stepCount > MAX_STEPS) {
          console.warn(
            `⚠️ WARNING: Reached maximum steps (${MAX_STEPS}) without completing the goal.`,
          );
          console.warn(`Goal was: "${goal}"`);
          console.warn(
            'Terminating browser session and continuing to next task.',
          );
          break;
        }

        // Take screenshot of current state for better context
        const screenshot = (await this.runAtomicStep(
          stagehandInstance,
          'SCREENSHOT',
        )) as string;

        // Use LLM to determine next step based on current state and goal
        console.log(`Planning step ${stepCount} to achieve goal...`);
        const { result, previousSteps: updatedSteps } = await this.sendPrompt(
          goal,
          stagehandInstance,
          previousSteps,
          extraction,
        );

        console.log(
          `Executing step ${stepCount}: ${result.text} (using ${result.tool})`,
        );

        // Loop detection: Check if we're repeating the same action
        const currentAction = `${result.tool}:${result.instruction}`;
        if (currentAction === lastAction) {
          similarStepsCount++;
          if (similarStepsCount >= MAX_SIMILAR_STEPS) {
            console.warn(
              `⚠️ WARNING: Detected loop - same action repeated ${MAX_SIMILAR_STEPS} times.`,
            );
            console.warn(`Action: ${currentAction}`);
            console.warn(`Stopping execution and returning collected results.`);
            break;
          }
        } else {
          similarStepsCount = 0;
          lastAction = currentAction;
        }

        // Execute the determined step
        try {
          extraction = await this.runAtomicStep(
            stagehandInstance,
            result.tool,
            result.instruction,
          );

          if (result.tool === 'EXTRACT' || result.tool === 'OBSERVE') {
            console.log(`Extracted information: ${extraction}`);
            // Store extracted information in results
            results.push({
              step: stepCount,
              type: result.tool,
              data: extraction,
            });
          }
        } catch (error) {
          console.error(`Error executing step ${stepCount}:`, error);
          await stagehandInstance.close();
          throw error;
        }

        previousSteps = updatedSteps;

        // If goal is achieved, LLM will return CLOSE action
        if (result.tool === 'CLOSE') {
          console.log(
            `Goal achieved after ${stepCount} steps. Closing browser.`,
          );
          await stagehandInstance.close();
          goalCompleted = true;
          break;
        }
      }

      return {
        message: goalCompleted
          ? 'Task completed successfully'
          : `Task terminated after ${stepCount} steps${
              similarStepsCount >= MAX_SIMILAR_STEPS
                ? ' (detected repetitive actions)'
                : stepCount >= MAX_STEPS
                  ? ' (reached maximum steps)'
                  : ''
            }`,
        steps: previousSteps,
        totalSteps: stepCount,
        completed: goalCompleted,
        results: results,
      };
    } catch (error) {
      console.error('Error executing goal:', error);
      throw new Error(
        `Browser operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    } finally {
      // Ensure browser is closed even if there's an error
      try {
        await stagehandInstance.close();
      } catch (e) {
        // Ignore close errors
      }
    }
  }

  private async runAtomicStep(
    stagehandInstance: Stagehand,
    method: AtomicMethod,
    instruction?: string,
  ): Promise<any> {
    const page = stagehandInstance.page;
    try {
      switch (method) {
        case 'GOTO':
          await page.goto(instruction!, {
            waitUntil: 'commit',
            timeout: 60000,
          });
          break;
        case 'ACT':
          await page.act(instruction!);
          break;
        case 'EXTRACT': {
          const { extraction } = await page.extract(instruction!);
          return extraction;
        }
        case 'OBSERVE':
          return await page.observe({
            instruction,
            onlyVisible: false,
          });
        case 'CLOSE':
          await stagehandInstance.close();
          break;
        case 'SCREENSHOT': {
          // Replace CDP screenshot with Playwright's native screenshot method
          const screenshotBuffer = await page.screenshot({
            type: 'png',
            fullPage: true,
          });
          // Convert Buffer to base64 string
          const cdpSession = await page.context().newCDPSession(page);
          const { data } = await cdpSession.send('Page.captureScreenshot');
          return data;
        }
        case 'WAIT':
          await new Promise((resolve) =>
            setTimeout(resolve, Number(instruction)),
          );
          break;
        case 'NAVBACK':
          await page.goBack();
          break;
        default:
          throw new Error(`Unsupported atomic method: ${method}`);
      }
    } catch (error) {
      await stagehandInstance.close();
      throw error;
    }
  }

  private async sendPrompt(
    goal: string,
    stagehandInstance: Stagehand,
    previousSteps: Step[],
    previousExtraction?: string | ObserveResult[],
  ): Promise<{ result: Step; previousSteps: Step[] }> {
    let currentUrl = '';
    try {
      currentUrl = await stagehandInstance.page.url();
    } catch (error) {
      console.error('Error getting page info:', error);
    }

    const content: UserContent = [
      {
        type: 'text',
        text: `Consider the following screenshot of a web page${currentUrl ? ` (URL: ${currentUrl})` : ''}, with the goal being "${goal}".
${
  previousSteps.length > 0
    ? `Previous steps taken:
${previousSteps
  .map(
    (step, index) => `
Step ${index + 1}:
- Action: ${step.text}
- Reasoning: ${step.reasoning}
- Tool Used: ${step.tool}
- Instruction: ${step.instruction}
`,
  )
  .join('\n')}`
    : ''
}
Determine the immediate next step to take to achieve the goal.

Important guidelines:
1. Break down complex actions into individual atomic steps.
2. For ACT commands, use only one action at a time.
3. Avoid combining multiple actions in one instruction.
If the goal has been achieved, return "CLOSE".`,
      },
    ];

    // Add screenshot if a GOTO step was executed previously.
    if (
      previousSteps.length > 0 &&
      previousSteps.some((step) => step.tool === 'GOTO')
    ) {
      const screenshot = (await this.runAtomicStep(
        stagehandInstance,
        'SCREENSHOT',
      )) as string;
      content.push({
        type: 'image',
        image: screenshot,
      });
    }

    if (previousExtraction) {
      content.push({
        type: 'text',
        text: `The result of the previous ${Array.isArray(previousExtraction) ? 'observation' : 'extraction'} is: ${previousExtraction}.`,
      });
    }

    const message: CoreMessage = {
      role: 'user',
      content,
    };

    const result = await generateObject({
      model: openai('gpt-4o'),
      schema: z.object({
        text: z.string(),
        reasoning: z.string(),
        tool: z.enum([
          'GOTO',
          'ACT',
          'EXTRACT',
          'OBSERVE',
          'CLOSE',
          'SCREENSHOT',
          'WAIT',
          'NAVBACK',
        ]),
        instruction: z.string(),
      }),
      messages: [message],
    });

    return {
      result: result.object,
      previousSteps: [...previousSteps, result.object],
    };
  }

  private async selectStartingUrl(
    goal: string,
  ): Promise<{ url: string; reasoning: string }> {
    const message: CoreMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Given the goal: "${goal}", determine the best URL to start from.
Choose from:
1. A relevant search engine (Google, Bing, etc.)
2. A direct URL if you're confident about the target website
3. Any other appropriate starting point

Return a URL that would be most effective for achieving this goal.`,
        },
      ],
    };

    const result = await generateObject({
      model: openai('gpt-4o'),
      schema: z.object({
        url: z.string().url(),
        reasoning: z.string(),
      }),
      messages: [message],
    });

    return result.object;
  }

  async cleanup() {
    if (this.browser) {
      // Use the proper close method for the Stagehand instance
      await this.browser.close();
      this.browser = null;
    }
  }
}

// Export an instance of the tool
export const browserTool = new BrowserTool();
