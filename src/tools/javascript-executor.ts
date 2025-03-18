import { z } from 'zod';
import { Tool } from '../types';
import { NodeVM } from 'vm2';

const JavascriptExecutorSchema = z.object({
  code: z.string().min(1, 'JavaScript code is required'),
  timeout: z.number().positive().default(10000).optional(),
  allowHarmfulOperations: z.boolean().default(false).optional(),
  contextData: z.record(z.any()).optional(),
});

export class JavascriptExecutorTool implements Tool {
  name = 'javascriptExecutor';
  description =
    'Execute JavaScript code to calculate data or visualize results';
  parameters = JavascriptExecutorSchema;

  async execute(args: z.infer<typeof JavascriptExecutorSchema>) {
    const {
      code,
      timeout = 10000,
      allowHarmfulOperations = false,
      contextData = {},
    } = args;

    try {
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

      // Return the execution result
      return await result;
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
