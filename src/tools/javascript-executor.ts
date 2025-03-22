import { z } from 'zod';
import { Tool } from '../types';
import { NodeVM } from 'vm2';
import { generateObject } from 'ai';
import { openai } from '@ai-sdk/openai';

export class JavascriptExecutorTool implements Tool {
  name = 'javascriptExecutor';
  description =
    'Generate JavaScript code to complete the task, such as data calculation...etc and execute the code';
  parameters: any;

  async execute(params: { description: string }) {
    const { description } = params;

    try {
      // Generate JavaScript code using LLM based on the description
      const { object: generatedCode } = await generateObject({
        model: openai(process.env.DEFAULT_LLM_MODEL || 'gpt-4o-mini'),
        schema: z.object({
          code: z.string().describe('The generated JavaScript code'),
        }),
        prompt: `Generate JavaScript code to accomplish this task: ${description}. 
                      The code should be executable in a Node.js environment.
                      Return only the code, without any comments or explanations.`,
      });

      const code = generatedCode.code;
      const timeout = 10000;
      const allowHarmfulOperations = false;
      const contextData = {};

      // Create a sandboxed environment using vm2
      const vm = new NodeVM({
        console: 'inherit',
        sandbox: { ...contextData },
        timeout: timeout,
        // Only allow requiring modules in allowHarmfulOperations mode
        require: {
          external: allowHarmfulOperations,
          builtin: allowHarmfulOperations ? ['*'] : [],
          root: allowHarmfulOperations ? './' : [],
        },
      });

      // Execute the code in the VM
      const result = vm.run(`module.exports = (async () => { 
        try {
          ${code}
        } catch (e) {
          return { error: e.message };
        }
      })();`);

      // Return the execution result and the code that was generated
      const executionResult = await result;
      return {
        code,
        result: executionResult,
        success: !executionResult?.error,
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred';

      return {
        error: `JavaScript execution failed: ${errorMessage}`,
        success: false,
      };
    }
  }
}

// Export an instance of the tool for use
export const javascriptExecutorTool = new JavascriptExecutorTool();
