import { promises as fs } from 'fs';
import * as stdFs from 'fs';
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

/**
 * Creates a task folder with the given timestamp
 * @param timestamp Task timestamp
 * @returns Path to the created task folder
 */
export const createTaskFolder = async (timestamp: number): Promise<string> => {
  const taskFolderPath = `tasks/task-${timestamp}`;

  try {
    // Create tasks directory if it doesn't exist
    if (!stdFs.existsSync('tasks')) {
      await fs.mkdir('tasks', { recursive: true });
    }

    // Create the task folder
    if (!stdFs.existsSync(taskFolderPath)) {
      await fs.mkdir(taskFolderPath, { recursive: true });
    }

    return taskFolderPath;
  } catch (error: any) {
    console.error('Error creating task folder:', error);
    throw new Error(`Failed to create task folder: ${error.message}`);
  }
};

/**
 * Creates a todo.md file in the task folder
 * @param taskFolderPath Path to the task folder
 * @param task Main task description
 * @param subtasks List of subtasks
 * @returns FileOperationResult
 */
export const createTodoMd = async (
  taskFolderPath: string,
  task: string,
  subtasks: { description: string; status: 'pending' | 'completed' }[],
): Promise<FileOperationResult> => {
  const todoMdPath = `${taskFolderPath}/todo.md`;

  try {
    let content = `# Task: ${task}\n\nCreated: ${new Date().toISOString()}\n\n## Subtasks\n\n`;

    subtasks.forEach((subtask, index) => {
      const statusMark = subtask.status === 'completed' ? '[x]' : '[ ]';
      content += `${index + 1}. ${statusMark} ${subtask.description}\n`;
    });

    await fs.writeFile(todoMdPath, content, 'utf8');

    return {
      success: true,
      message: `Todo.md created successfully at ${todoMdPath}`,
      data: todoMdPath,
    };
  } catch (error: any) {
    console.error('Error creating todo.md:', error);
    return {
      success: false,
      message: `Failed to create todo.md: ${error.message}`,
    };
  }
};

/**
 * Updates a subtask status in todo.md
 * @param todoMdPath Path to the todo.md file
 * @param subtaskIndex Index of the subtask (1-based)
 * @param status New status ('pending' or 'completed')
 * @param note Optional note to add to the subtask
 * @returns FileOperationResult
 */
export const updateSubtaskStatus = async (
  todoMdPath: string,
  subtaskIndex: number,
  status: 'pending' | 'completed',
  note?: string,
): Promise<FileOperationResult> => {
  try {
    let exists = false;
    try {
      await fs.access(todoMdPath);
      exists = true;
    } catch (accessError) {
      exists = false;
    }

    if (!exists) {
      return {
        success: false,
        message: `Todo.md not found at ${todoMdPath}`,
      };
    }

    const content = await fs.readFile(todoMdPath, 'utf8');
    const lines = content.split('\n');

    // Find the subtask line
    const subtaskRegex = new RegExp(`^${subtaskIndex}\\. \\[([ x])\\] (.+)$`);

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(subtaskRegex);
      if (match) {
        // Replace the status mark
        const statusMark = status === 'completed' ? '[x]' : '[ ]';
        let newLine = `${subtaskIndex}. ${statusMark} ${match[2]}`;

        // Add note if provided
        if (note) {
          newLine += ` - *${note}*`;
        }

        lines[i] = newLine;
        break;
      }
    }

    // Write the updated content
    await fs.writeFile(todoMdPath, lines.join('\n'), 'utf8');

    return {
      success: true,
      message: `Subtask ${subtaskIndex} status updated to ${status}`,
      data: todoMdPath,
    };
  } catch (error: any) {
    console.error('Error updating subtask status:', error);
    return {
      success: false,
      message: `Failed to update subtask status: ${error.message}`,
    };
  }
};

/**
 * Adds a new subtask to todo.md
 * @param todoMdPath Path to the todo.md file
 * @param description Description of the new subtask
 * @returns FileOperationResult
 */
export const addSubtask = async (
  todoMdPath: string,
  description: string,
): Promise<FileOperationResult> => {
  try {
    if (!stdFs.existsSync(todoMdPath)) {
      return {
        success: false,
        message: `Todo.md not found at ${todoMdPath}`,
      };
    }

    const content = await fs.readFile(todoMdPath, 'utf8');
    const lines = content.split('\n');

    // Find the subtasks section and count existing subtasks
    let subtasksIndex = -1;
    let subtaskCount = 0;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('## Subtasks')) {
        subtasksIndex = i;
      } else if (subtasksIndex !== -1 && lines[i].match(/^\d+\. \[[ x]\] /)) {
        subtaskCount++;
      }
    }

    if (subtasksIndex === -1) {
      return {
        success: false,
        message: 'Subtasks section not found in todo.md',
      };
    }

    // Add the new subtask
    const newSubtaskLine = `${subtaskCount + 1}. [ ] ${description}`;
    lines.splice(subtasksIndex + subtaskCount + 1, 0, newSubtaskLine);

    // Write the updated content
    await fs.writeFile(todoMdPath, lines.join('\n'), 'utf8');

    return {
      success: true,
      message: `New subtask added: ${description}`,
      data: {
        subtaskIndex: subtaskCount + 1,
        description,
      },
    };
  } catch (error: any) {
    console.error('Error adding subtask:', error);
    return {
      success: false,
      message: `Failed to add subtask: ${error.message}`,
    };
  }
};

/**
 * Adds a reasoning note to todo.md
 * @param todoMdPath Path to the todo.md file
 * @param reasoning Reasoning text
 * @returns FileOperationResult
 */
export const addReasoningToTodo = async (
  todoMdPath: string,
  reasoning: string,
): Promise<FileOperationResult> => {
  try {
    if (!stdFs.existsSync(todoMdPath)) {
      return {
        success: false,
        message: `Todo.md not found at ${todoMdPath}`,
      };
    }

    const content = await fs.readFile(todoMdPath, 'utf8');

    // Check if there's already a reasoning section
    if (content.includes('## Reasoning')) {
      // Update existing reasoning section
      const reasoningRegex = /## Reasoning\n\n([\s\S]*?)(?=\n##|$)/;
      const match = content.match(reasoningRegex);

      if (match) {
        // Add new reasoning to existing content
        const updatedReasoning = `${match[1].trim()}\n\n${new Date().toISOString()}: ${reasoning}`;
        const updatedContent = content.replace(
          reasoningRegex,
          `## Reasoning\n\n${updatedReasoning}\n\n`,
        );
        await fs.writeFile(todoMdPath, updatedContent, 'utf8');
      } else {
        // Something is wrong, add a new section
        const updatedContent =
          content +
          `\n\n## Reasoning\n\n${new Date().toISOString()}: ${reasoning}\n`;
        await fs.writeFile(todoMdPath, updatedContent, 'utf8');
      }
    } else {
      // Add a new reasoning section
      const updatedContent =
        content +
        `\n\n## Reasoning\n\n${new Date().toISOString()}: ${reasoning}\n`;
      await fs.writeFile(todoMdPath, updatedContent, 'utf8');
    }

    return {
      success: true,
      message: 'Reasoning added to todo.md',
      data: todoMdPath,
    };
  } catch (error: any) {
    console.error('Error adding reasoning to todo.md:', error);
    return {
      success: false,
      message: `Failed to add reasoning: ${error.message}`,
    };
  }
};
