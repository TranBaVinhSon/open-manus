import { z } from 'zod';
import { Tool } from '../types/agent';
// Remove the legacy import and use only the official package
import { Stagehand, ObserveResult } from '@browserbasehq/stagehand';
import { CoreMessage, generateObject, generateText, UserContent } from 'ai';
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
  | 'NAVBACK'
  | 'HTML'
  | 'CLOSE'
  | 'AI_HANDLE';

type Step = {
  text: string;
  reasoning: string;
  method: AtomicMethod;
  instruction?: string;
  result?: any; // Store the actual result of the step execution
  timestamp?: string; // When the step was executed
  url?: string; // URL at the time of step execution
};

// Add new types for structured results
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
  private async executeGoal(
    goal: string,
    providedUrl?: string,
  ): Promise<BrowserResult> {
    // Ensure browsers are installed before proceeding
    await this.ensureBrowsersInstalled();

    // Get maximum steps from environment variable with default fallback
    const MAX_STEPS = parseInt(process.env.MAX_STEPS || '10');
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

      // // Step 1: Determine starting URL (use provided URL or select one)
      // let startUrl: string;
      // let startUrlReasoning: string;

      // if (providedUrl) {
      //   startUrl = providedUrl;
      //   startUrlReasoning = 'Using the URL provided in the request';
      // } else {
      //   // Select starting URL using LLM
      //   const result = await this.selectStartingUrl(goal);
      //   startUrl = result.url;
      //   startUrlReasoning = result.reasoning;
      // }

      // console.log(`Starting URL: ${startUrl} (Reason: ${startUrlReasoning})`);

      // First step is always navigation to the starting URL
      const firstStep: Step = {
        text: `Navigating to ${providedUrl}`,
        reasoning: goal,
        method: 'GOTO',
        instruction: 'Navigating to the URL provided in the request',
      };

      // Execute first step: navigate
      console.log(`Executing step 1: ${firstStep.text}`);
      await this.runAtomicStep(stagehandInstance, 'GOTO', providedUrl);

      let previousSteps: Step[] = [firstStep];
      let stepCount = 1;
      let goalCompleted = false;
      // Initialize results collection with better typing
      let results: ExtractedData[] = [];

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

        // Use LLM to determine next step based on current state and goal
        const { result, previousSteps: updatedSteps } = await this.sendPrompt(
          goal,
          stagehandInstance,
          previousSteps,
          previousSteps.length > 0
            ? previousSteps[previousSteps.length - 1].result
            : undefined,
        );

        // Simple check if the result indicates goal completion
        if (result.method === 'CLOSE') {
          console.log(
            `Goal completion detected in step result. Closing browser.`,
          );
          await stagehandInstance.close();
          goalCompleted = true;
          previousSteps = updatedSteps;
          break;
        }

        // Add current URL and timestamp to step data
        result.timestamp = new Date().toISOString();
        try {
          result.url = await stagehandInstance.page.url();
        } catch (error) {
          console.error('Error getting page URL:', error);
        }

        console.log(
          `Executing step ${stepCount}: ${result.text} (using ${result.method})`,
        );

        // Handle AI_HANDLE tool type
        if (result.method === 'AI_HANDLE') {
          console.log(`Delegating task to AI: ${result.instruction}`);
          try {
            // Process the task with AI
            const aiResult = await this.processWithAI(result.instruction!);
            console.log(`AI result: ${JSON.stringify(aiResult, null, 2)}`);

            // Add the AI result to the results collection
            results.push({
              type: 'ai_analysis',
              content: aiResult,
              metadata: {
                tool: 'AI_HANDLE',
                instruction: result.instruction,
                timestamp: new Date().toISOString(),
              },
            });

            // Update previous steps and continue to next iteration
            previousSteps = updatedSteps;
            continue;
          } catch (error) {
            console.error(`Error processing with AI: ${error}`);
            // Fall back to browser-based processing if AI fails
          }
        }

        // Loop detection: Check if we're repeating the same action
        const currentAction = `${result.method}:${result.instruction}`;
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

        // Only execute browser steps if not handled by AI
        // Execute the determined step with browser
        try {
          // Store the result directly in the step data
          result.result = await this.runAtomicStep(
            stagehandInstance,
            result.method,
            result.instruction,
          );

          if (result.method === 'EXTRACT' || result.method === 'HTML') {
            console.log(
              `Extracted information: ${typeof result.result === 'string' ? result.result : JSON.stringify(result.result)}`,
            );

            // Process and structure the extracted data
            const processedData = await this.processExtractedData(
              result.result,
              result.method as 'EXTRACT' | 'HTML',
              result.instruction!,
            );

            results.push(processedData);
          }
        } catch (error) {
          console.error(`Error executing step ${stepCount}:`, error);
          await stagehandInstance.close();
          throw error;
        }

        previousSteps = updatedSteps;
      }

      // Generate a summary before returning results
      const summary = await this.generateResultsSummary(results, goal);

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
        results,
        summary,
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
          // TODO: Using native extract API from Stagehand
          // const { extraction } = await page.extract(instruction!);

          // Check if instruction is defined before proceeding
          if (!instruction) {
            throw new Error('EXTRACT method requires an instruction');
          }

          // Fallback: Get HTML and use AI to extract the data
          const html = await page.content();

          // Process the HTML with AI to extract the requested data
          const extractedData = await this.processWithAI(
            `Extract the following from this HTML: ${instruction}\n\nHTML content: ${html}...`,
          );

          return extractedData;
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
          return Buffer.from(screenshotBuffer).toString('base64');
        }
        case 'WAIT':
          await new Promise((resolve) =>
            setTimeout(resolve, Number(instruction)),
          );
          break;
        case 'NAVBACK':
          await page.goBack();
          break;
        case 'HTML':
          // Use Playwright's page.content() to extract full page HTML
          return await page.content();
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
    previousResult?: any,
  ): Promise<{ result: Step; previousSteps: Step[] }> {
    let currentUrl = '';
    try {
      currentUrl = await stagehandInstance.page.url();
    } catch (error) {
      console.error('Error getting page info:', error);
    }

    // Keep it simple: just check if we have any results from previous steps
    const hasResults = previousSteps.some((step) => step.result);

    const content: UserContent = [
      {
        type: 'text',
        text: `Consider the following screenshot of a web page${currentUrl ? ` (URL: ${currentUrl})` : ''}, with the goal being "${goal}".
${hasResults ? '⚠️ IMPORTANT: Review previous steps and their results. If these results satisfy the original goal, return CLOSE to prevent infinite loops.' : ''}
${
  previousSteps.length > 0
    ? `Previous steps taken:
${previousSteps
  .map(
    (step, index) => `
Step ${index + 1}:
- Action: ${step.text}
- Reasoning: ${step.reasoning}
- Method Used: ${step.method}
- Instruction: ${step.instruction}${
      step.result
        ? `
- Result: ${typeof step.result === 'string' ? (step.result.length > 100 ? step.result.substring(0, 100) + '...' : step.result) : 'Data extracted'}`
        : ''
    }
`,
  )
  .join('\n')}`
    : ''
}
Determine the immediate next step to take to achieve the goal.

Important guidelines:
1. Break down complex actions into individual atomic steps.
2. Choose the appropriate method based on the task:
   - Use HTML: For getting the complete page source (SEO audits, page analysis)
   - Use EXTRACT: For getting specific elements with a clear instruction (prices, titles, specific content)
   - Use OBSERVE: For analyzing visible elements and their properties
   - Use ACT: For clicking, typing, or other interactions
   - Use WAIT: For waiting specific milliseconds
   - Use NAVBACK: For going back to previous page
   - Use AI_HANDLE: For tasks that can be handled by AI without browser interaction (analysis, summarization, etc.)
   - Use CLOSE when:
    - The goal has been achieved
    - You have collected all necessary information
    - No more browser interaction is needed
3. Each method requires specific instructions:
   - HTML: No instruction needed
   - EXTRACT: Must specify what to extract (e.g., "extract the main heading")
   - OBSERVE: Can provide specific instruction or leave empty for general observation
   - ACT: Must specify one clear action (e.g., "click #submit-button")
   - AI_HANDLE: Provide a clear instruction for the AI (e.g., "analyze this HTML for SEO issues")
   - CLOSE: No instruction needed
4. Best practices:
   - Break down complex tasks into smaller, atomic steps
     - Example of ACT method:
      - DON'T: log in and purchase the first item
      - DO:
        - click the login button
        - click on the first item
        - click the purchase button

   - Don't use broad or ambiguous instructions like "find something interesting on the page"
   - Avoid combining actions such as "fill out the form and submit it"
   - Avoid perform high-level planning or reasoning such as "book the cheapest flight available"

   
MOST IMPORTANT: After each step, evaluate if the goal "${goal}" has been achieved based on the results of the current and previous steps. If it has, return CLOSE with completed=true and the method will be CLOSE. This is critical to prevent infinite loops.`,
      },
    ];

    // Add screenshot if a GOTO step was executed previously.
    if (
      previousSteps.length > 0 &&
      previousSteps.some((step) => step.method === 'GOTO')
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

    if (previousResult) {
      content.push({
        type: 'text',
        text: `The result of the previous extraction is: ${
          typeof previousResult === 'string'
            ? previousResult
            : JSON.stringify(previousResult)
        }`,
      });
    }

    const message: CoreMessage = {
      role: 'user',
      content,
    };

    // console.log('Sending prompt:', JSON.stringify(message, null, 2));
    const result = await generateObject({
      model: openai('gpt-4o-mini'),
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
        instruction: z.string().describe('The instruction for the tool'),
      }),
      messages: [message],
    });

    return {
      result: result.object,
      previousSteps: [...previousSteps, result.object],
    };
  }

  // Add new helper method to process extracted data
  private async processExtractedData(
    data: any,
    tool: 'EXTRACT' | 'HTML',
    instruction: string,
  ): Promise<ExtractedData> {
    // Convert non-serializable data to serializable format
    let processableData = data;

    // If data is not a string or plain object, convert it to a string representation
    if (
      typeof data !== 'string' &&
      typeof data !== 'number' &&
      typeof data !== 'boolean'
    ) {
      try {
        processableData = JSON.stringify(data);
      } catch (e) {
        // If JSON stringification fails, convert to string
        processableData = String(data);
      }
    }

    // For HTML content, we don't need to parse it since Stagehand/Playwright
    // already provides structured data through its extract/observe methods
    if (tool === 'HTML' || tool === 'EXTRACT') {
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

    // Handle JSON data
    if (
      typeof processableData === 'string' &&
      processableData.trim().startsWith('{')
    ) {
      try {
        const jsonData = JSON.parse(processableData);
        return {
          type: 'json',
          content: jsonData,
          metadata: {
            tool,
            instruction,
            timestamp: new Date().toISOString(),
          },
        };
      } catch (e) {
        // If JSON parsing fails, fall through to default handling
      }
    }

    // Default handling for other types of data
    return {
      type: 'raw',
      content: processableData,
      metadata: {
        tool,
        instruction,
        timestamp: new Date().toISOString(),
      },
    };
  }

  // Add method to generate a summary of results
  private async generateResultsSummary(
    results: ExtractedData[],
    goal: string,
  ): Promise<string> {
    // Ensure results are serializable
    const safeResults = results.map((result) => {
      try {
        // Test if the result can be serialized
        JSON.stringify(result);
        return result;
      } catch (e) {
        // If serialization fails, create a safe version
        return {
          type: result.type || 'unknown',
          content:
            typeof result.content === 'string'
              ? result.content
              : 'Non-serializable content',
          metadata: result.metadata || {
            note: 'Original metadata was not serializable',
          },
        };
      }
    });

    const message: CoreMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Given the following extracted data and the original goal: "${goal}", 
                provide a concise summary of the findings:
                ${JSON.stringify(safeResults, null, 2)}`,
        },
      ],
    };

    const response = await generateObject({
      model: openai('gpt-4o-mini'),
      schema: z.object({
        summary: z.string(),
      }),
      messages: [message],
    });

    return response.object.summary;
  }

  // Add a new method to process tasks with AI
  private async processWithAI(instruction: string): Promise<string> {
    console.log(`Processing with AI: ${instruction.substring(0, 100)}...`);

    // Prepare the message for the AI
    const message: CoreMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Task: ${instruction}\n\nPlease analyze and provide a detailed response.`,
        },
      ],
    };

    // Generate the response using generateText
    const response = await generateText({
      model: openai('gpt-4o-mini'),
      messages: [message],
    });

    return response.text;
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
