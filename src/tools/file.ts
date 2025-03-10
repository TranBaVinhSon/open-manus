import { promises as fs } from 'fs';
import path from 'path';
import { FileOperationResult, Tool } from '../types';
import crypto from 'crypto';

// Use fs.promises functions directly
const readFileAsync = fs.readFile;
const writeFileAsync = fs.writeFile;
const mkdirAsync = fs.mkdir;
const accessAsync = fs.access;
const statAsync = fs.stat;
const readdirAsync = fs.readdir;

// File operations tool
export const fileOperationsTool: Tool & {
  readFile(filename: string): Promise<string>;
  initializeTaskEnvironment(): Promise<void>;
  generateOutputFilePath(
    taskName: string,
    extension: 'md' | 'html',
  ): Promise<string>;
  createTaskFolder(taskName: string): Promise<string>;
  readTaskFile(taskFolder: string, filename: string): Promise<string>;
  writeTaskFile(
    taskFolder: string,
    filename: string,
    content: string,
  ): Promise<void>;
  getTaskFinalOutputPath(taskFolder: string, extension: 'md' | 'html'): string;
} = {
  name: 'fileOperations',
  description: 'Read and write files on the local filesystem',
  execute: async (
    params: Record<string, any>,
  ): Promise<FileOperationResult> => {
    const { operation, filePath, content, encoding = 'utf8' } = params;

    if (!operation) {
      return {
        success: false,
        message: 'Operation type is required',
      };
    }

    if (!filePath) {
      return {
        success: false,
        message: 'File path is required',
      };
    }

    try {
      switch (operation) {
        case 'read': {
          // Check if file exists
          try {
            await accessAsync(filePath, fs.constants.R_OK);
          } catch (error) {
            return {
              success: false,
              message: `File does not exist or is not readable: ${filePath}`,
            };
          }

          const data = await readFileAsync(filePath, {
            encoding: encoding as BufferEncoding,
          });
          return {
            success: true,
            message: `Successfully read file: ${filePath}`,
            data,
          };
        }

        case 'write': {
          if (content === undefined) {
            return {
              success: false,
              message: 'Content is required for write operation',
            };
          }

          // Ensure directory exists
          const directory = path.dirname(filePath);
          try {
            await accessAsync(directory, fs.constants.F_OK);
          } catch {
            // Directory doesn't exist, create it
            await mkdirAsync(directory, { recursive: true });
          }

          await writeFileAsync(filePath, content, {
            encoding: encoding as BufferEncoding,
          });
          return {
            success: true,
            message: `Successfully wrote to file: ${filePath}`,
          };
        }

        case 'list': {
          try {
            await accessAsync(filePath, fs.constants.R_OK);
          } catch (error) {
            return {
              success: false,
              message: `Directory does not exist or is not readable: ${filePath}`,
            };
          }

          const stats = await statAsync(filePath);
          if (!stats.isDirectory()) {
            return {
              success: false,
              message: `Path is not a directory: ${filePath}`,
            };
          }

          const files = await readdirAsync(filePath);
          const fileDetails = await Promise.all(
            files.map(async (file) => {
              const fullPath = path.join(filePath, file);
              const fileStats = await statAsync(fullPath);
              return {
                name: file,
                path: fullPath,
                isDirectory: fileStats.isDirectory(),
                size: fileStats.size,
                created: fileStats.birthtime,
                modified: fileStats.mtime,
              };
            }),
          );

          return {
            success: true,
            message: `Successfully listed directory: ${filePath}`,
            data: fileDetails,
          };
        }

        default:
          return {
            success: false,
            message: `Unsupported operation: ${operation}`,
          };
      }
    } catch (error) {
      console.error('File operation error:', error);
      return {
        success: false,
        message: `File operation failed: ${(error as Error).message}`,
      };
    }
  },

  async writeFile(filename: string, content: string): Promise<void> {
    try {
      await fs.writeFile(filename, content, { encoding: 'utf8' });
      console.log(`File ${filename} written successfully.`);
    } catch (err) {
      console.error(`Error writing file ${filename}:`, err);
    }
  },

  async readFile(filename: string): Promise<string> {
    try {
      const data = await fs.readFile(filename, { encoding: 'utf8' });
      console.log(`Read file ${filename} successfully.`);
      return data;
    } catch (err) {
      console.error(`Error reading file ${filename}:`, err);
      throw err;
    }
  },

  async initializeTaskEnvironment(): Promise<void> {
    // Ensure results folder exists
    const resultsFolder = path.join(process.cwd(), 'results');
    await mkdirAsync(resultsFolder, { recursive: true });

    // Add results folder to .gitignore
    const gitignorePath = path.join(process.cwd(), '.gitignore');
    let gitignoreContent = '';
    try {
      gitignoreContent = await fs.readFile(gitignorePath, { encoding: 'utf8' });
    } catch {
      // If .gitignore doesn't exist, we'll create it
    }
    if (!gitignoreContent.includes('results/')) {
      gitignoreContent = gitignoreContent.trim() + '\nresults/\n';
      await fs.writeFile(gitignorePath, gitignoreContent, { encoding: 'utf8' });
    }
  },

  async generateOutputFilePath(
    taskName: string,
    extension: 'md' | 'html',
  ): Promise<string> {
    // Create a task folder and return a file path inside it
    const taskFolder = await this.createTaskFolder(taskName);
    return this.getTaskFinalOutputPath(taskFolder, extension);
  },

  async createTaskFolder(taskName: string): Promise<string> {
    // Create a unique ID for the task
    const uniqueId = crypto.randomUUID();

    // Generate folder name: task-{uniqueId}
    const folderName = `task-${uniqueId}`;

    // Create full path
    const folderPath = path.join(process.cwd(), 'results', folderName);

    // Create the folder
    await mkdirAsync(folderPath, { recursive: true });

    // Create a metadata file to identify the task
    const metadataContent = JSON.stringify(
      {
        taskName,
        created: new Date().toISOString(),
        id: uniqueId,
      },
      null,
      2,
    );

    await fs.writeFile(
      path.join(folderPath, 'task-info.json'),
      metadataContent,
      { encoding: 'utf8' },
    );

    console.log(`Created task folder: ${folderPath}`);
    return folderPath;
  },

  async readTaskFile(taskFolder: string, filename: string): Promise<string> {
    const filePath = path.join(taskFolder, filename);
    try {
      const data = await fs.readFile(filePath, { encoding: 'utf8' });
      console.log(`Read task file ${filename} successfully.`);
      return data;
    } catch (err) {
      console.error(`Error reading task file ${filename}:`, err);
      throw err;
    }
  },

  async writeTaskFile(
    taskFolder: string,
    filename: string,
    content: string,
  ): Promise<void> {
    const filePath = path.join(taskFolder, filename);
    try {
      await fs.writeFile(filePath, content, { encoding: 'utf8' });
      console.log(`Task file ${filename} written successfully.`);
    } catch (err) {
      console.error(`Error writing task file ${filename}:`, err);
      throw err;
    }
  },

  getTaskFinalOutputPath(taskFolder: string, extension: 'md' | 'html'): string {
    return path.join(taskFolder, `final-result.${extension}`);
  },
};
