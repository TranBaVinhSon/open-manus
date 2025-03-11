import { spawn } from 'child_process';
import { Tool } from '../types';
import { existsSync } from 'fs';

interface TerminalResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode?: number;
}

// Get the default shell based on the OS and verify its existence
const getDefaultShell = (): string => {
  const shell = process.env.SHELL || '/bin/bash';
  if (!existsSync(shell)) {
    console.warn(`Shell ${shell} not found, falling back to /bin/bash`);
    return '/bin/bash';
  }
  return shell;
};

/**
 * Terminal tool for executing shell commands
 */
export const terminalTool: Tool = {
  name: 'terminal',
  description: 'Execute shell commands in the system terminal',
  execute: async (params: {
    command: string;
    workingDir?: string;
    timeout?: number;
  }): Promise<TerminalResult> => {
    const { command, workingDir = process.cwd(), timeout = 30000 } = params;

    return new Promise((resolve) => {
      let output = '';
      let errorOutput = '';

      // Get the appropriate shell
      const shell = getDefaultShell();
      const isWindows = process.platform === 'win32';

      // Debug logging
      console.log('Terminal execution debug info:');
      console.log('- Shell path:', shell);
      console.log('- Platform:', process.platform);
      console.log('- Working directory:', workingDir);
      console.log('- Command:', command);

      // Create the child process with the appropriate shell
      const childProcess = spawn(shell, [isWindows ? '/c' : '-c', command], {
        cwd: workingDir,
        shell: false, // We're explicitly handling the shell
        env: { ...process.env },
        windowsHide: true,
      });

      // Set timeout
      const timeoutId = setTimeout(() => {
        childProcess.kill();
        resolve({
          success: false,
          output,
          error: 'Command execution timed out',
          exitCode: -1,
        });
      }, timeout);

      // Collect stdout
      childProcess.stdout.on('data', (data) => {
        output += data.toString();
      });

      // Collect stderr
      childProcess.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      // Handle process completion
      childProcess.on('close', (code) => {
        clearTimeout(timeoutId);

        resolve({
          success: code === 0,
          output: output,
          error: errorOutput.length > 0 ? errorOutput : undefined,
          exitCode: code || 0,
        });
      });

      // Handle process errors
      childProcess.on('error', (err) => {
        clearTimeout(timeoutId);

        resolve({
          success: false,
          output: output,
          error: `Failed to execute command: ${err.message}`,
          exitCode: -1,
        });
      });
    });
  },
};
