#!/usr/bin/env ts-node

import fs from 'fs';
import path from 'path';
import { createInterface } from 'readline';
import chalk from 'chalk';
import ora from 'ora';
import dotenv from 'dotenv';
import { exec } from 'child_process';
import { promisify } from 'util';

dotenv.config();

const execAsync = promisify(exec);

// Parse command line arguments
const args = process.argv.slice(2);
let maxTasks: number | undefined = undefined;

// Check for --limit or -l flag
for (let i = 0; i < args.length; i++) {
  if ((args[i] === '--limit' || args[i] === '-l') && i + 1 < args.length) {
    maxTasks = parseInt(args[i + 1], 10);
    if (isNaN(maxTasks)) {
      console.error('Invalid limit value. Please provide a number.');
      process.exit(1);
    }
    i++; // Skip the next argument since we already processed it
  }
}

interface Task {
  task_id: string;
  Question: string;
  Level: number;
  file_name: string;
  'Final answer': string;
  'Annotator Metadata': {
    Steps: string;
    'Number of steps': string;
    'How long did this take?': string;
    Tools: string;
    'Number of tools': string;
  };
}

interface BenchmarkResult {
  task_id: string;
  question: string;
  level: number;
  official_answer: string;
  agent_answer: string;
  is_correct: boolean;
  has_attached_file: boolean;
  execution_time: number;
}

/**
 * Normalize a number string by removing units and commas
 */
function normalizeNumberStr(numberStr: string): number {
  // Replace common units and commas to allow conversion to float
  const cleanStr = numberStr.replace(/[$%,]/g, '');
  const num = parseFloat(cleanStr);
  if (isNaN(num)) {
    console.warn(`String ${numberStr} cannot be normalized to number.`);
    return Infinity;
  }
  return num;
}

/**
 * Split a string by specified delimiters
 */
function splitString(s: string, charList: string[] = [',', ';']): string[] {
  const pattern = new RegExp(`[${charList.join('')}]`);
  return s.split(pattern).map((item) => item.trim());
}

/**
 * Normalize a string by removing spaces and optionally punctuation
 */
function normalizeStr(inputStr: string, removePunct: boolean = true): string {
  // Remove all white spaces
  const noSpaces = inputStr.replace(/\s/g, '');

  // Remove punctuation if specified
  if (removePunct) {
    return noSpaces.toLowerCase().replace(/[^\w\s]/g, '');
  }
  return noSpaces.toLowerCase();
}

/**
 * Score an answer against ground truth with type-specific handling
 */
function isAnswerCorrect(groundTruth: string, modelAnswer: string): boolean {
  if (!modelAnswer) {
    return false;
  }

  const isFloat = (str: string): boolean =>
    !isNaN(parseFloat(str)) && isFinite(parseFloat(str));

  // If ground truth is a number
  if (isFloat(groundTruth)) {
    const normalizedAnswer = normalizeNumberStr(modelAnswer);
    return normalizedAnswer === parseFloat(groundTruth);
  }

  // If ground truth is a list (contains commas or semicolons)
  else if (/[,;]/.test(groundTruth)) {
    const gtElems = splitString(groundTruth);
    const maElems = splitString(modelAnswer);

    // Check if lists have the same length
    if (gtElems.length !== maElems.length) {
      return false;
    }

    // Compare each element
    return gtElems.every((gtElem, i) => {
      const maElem = maElems[i];

      if (isFloat(gtElem)) {
        const normalizedMaElem = normalizeNumberStr(maElem);
        return normalizedMaElem === parseFloat(gtElem);
      } else {
        return normalizeStr(maElem, false) === normalizeStr(gtElem, false);
      }
    });
  }

  // If ground truth is a regular string
  else {
    return normalizeStr(modelAnswer) === normalizeStr(groundTruth);
  }
}

/**
 * Extract the final answer from agent output
 */
function extractAnswer(output: string): string {
  // First, clean up the output by removing any command line artifacts
  output = output.replace(/yarn run v[\d\.]+.*?\$ ts-node.*/gs, '');
  output = output.replace(/Agent started for task:.*/g, '');
  output = output.replace(/--- Step \d+ ---/g, '');
  output = output.replace(/Task completed:.*/g, '');

  // First look for a clear final answer section
  const finalAnswerSection = output.match(
    /Final answer:\s*([\s\S]*?)(?:\n\n|\n?$)/i,
  );
  if (finalAnswerSection && finalAnswerSection[1]) {
    return finalAnswerSection[1].trim();
  }

  // Look for phrases that might indicate a final answer
  const answerPatterns = [
    /final answer:?\s*([\s\S]*?)(?:\n\n|\n?$)/i,
    /my answer:?\s*([\s\S]*?)(?:\n\n|\n?$)/i,
    /answer:?\s*([\s\S]*?)(?:\n\n|\n?$)/i,
    /conclusion:?\s*([\s\S]*?)(?:\n\n|\n?$)/i,
    /result:?\s*([\s\S]*?)(?:\n\n|\n?$)/i,
    /output:?\s*([\s\S]*?)(?:\n\n|\n?$)/i,
  ];

  for (const pattern of answerPatterns) {
    const match = output.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  // Look for a response surrounded by quotes or special formatting
  const quotedAnswer = output.match(/"([^"]+)"/);
  if (quotedAnswer && quotedAnswer[1]) {
    return quotedAnswer[1].trim();
  }

  // If no clear answer pattern is found, use the last few sentences
  const paragraphs = output.split(/\n\n+/).filter((p) => p.trim().length > 0);
  if (paragraphs.length > 0) {
    // Get the last paragraph that looks like an answer
    const lastParagraph = paragraphs[paragraphs.length - 1].trim();

    // If it's short, it's likely a direct answer
    if (lastParagraph.length < 100) {
      return lastParagraph;
    }

    // Otherwise, get the last sentence
    const sentences = lastParagraph
      .split(/[.!?]+/)
      .filter((s) => s.trim().length > 0);
    if (sentences.length > 0) {
      return sentences[sentences.length - 1].trim();
    }

    return lastParagraph;
  }

  // If all else fails, just return the last 100 characters
  if (output.length > 100) {
    return output.slice(output.length - 100).trim();
  }

  return output.trim();
}

/**
 * Run a single task using the agent via yarn start command
 */
async function runTask(
  question: string,
): Promise<{ output: string; error: string | null }> {
  try {
    // Escape double quotes in the question
    const escapedQuestion = question.replace(/"/g, '\\"');

    console.log(`escapedQuestion`, escapedQuestion);

    // Execute the agent with the given task
    const { stdout, stderr } = await execAsync(
      `yarn start -t "${escapedQuestion}"`,
    );

    // Extract only the relevant part of the output
    let output = stdout;

    // Filter out the yarn run message
    output = output.replace(/yarn run v[\d\.]+([\s\S]*?\$ ts-node.*)/g, '');

    console.log(`output`, output);

    // Look for patterns that indicate the actual output vs. operational logs
    const taskOutputPattern = /Task completed: (.*)$/m;
    const completionMatch = output.match(taskOutputPattern);

    console.log(`completionMatch`, completionMatch);

    if (completionMatch && completionMatch[1]) {
      // If we found a completion message, use that as the answer
      return { output: completionMatch[1], error: null };
    }

    // Look for the final result or answer section
    const finalResultPattern =
      /=+ (?:RESULT|FINAL ANSWER|ANSWER|REPORT) =+[\s\S]*?([\s\S]+?)(?:=+|$)/i;
    const resultMatch = output.match(finalResultPattern);

    console.log(`resultMatch`, resultMatch);

    if (resultMatch && resultMatch[1]) {
      return { output: resultMatch[1], error: null };
    }

    // If we can't find a specific result section, extract all lines that look like answers
    // and not operational messages
    const lines = output.split('\n').filter((line) => {
      // Exclude operational messages
      return !line.match(
        /^\s*(yarn|node|ts-node|Agent started|Task completed|Executing|Determining|Step|Error)/i,
      );
    });

    // Join the filtered lines
    const filteredOutput = lines.join('\n').trim();

    return { output: filteredOutput || output, error: null };
  } catch (error) {
    if (error instanceof Error) {
      return {
        output: '',
        error: error.message || 'Unknown error',
      };
    }
    return { output: '', error: String(error) };
  }
}

/**
 * Analyze results by difficulty level
 */
function analyzeResultsByLevel(
  results: BenchmarkResult[],
): Record<number, { total: number; correct: number; accuracy: number }> {
  const levelStats: Record<
    number,
    { total: number; correct: number; accuracy: number }
  > = {};

  // Group results by level
  for (const result of results) {
    if (result.official_answer === '?') continue; // Skip tasks with unknown answers

    if (!levelStats[result.level]) {
      levelStats[result.level] = { total: 0, correct: 0, accuracy: 0 };
    }

    levelStats[result.level].total++;
    if (result.is_correct) {
      levelStats[result.level].correct++;
    }
  }

  // Calculate accuracy for each level
  for (const level in levelStats) {
    const stats = levelStats[level];
    stats.accuracy = stats.total > 0 ? (stats.correct / stats.total) * 100 : 0;
  }

  return levelStats;
}

/**
 * Run the benchmark on all tasks from the metadata file
 */
async function runBenchmark() {
  const spinner = ora('Starting benchmark').start();

  try {
    // Setup paths
    const metadataPath = path.join(
      __dirname,
      '2023',
      'validation',
      'metadata.jsonl',
    );
    const filesDir = path.join(__dirname, '2023', 'validation');

    // Create timestamp for results file
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const resultsDir = path.join(process.cwd(), 'src', 'benchmark', 'results');

    // Create the results directory if it doesn't exist
    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir, { recursive: true });
    }

    const resultsFile = path.join(resultsDir, `benchmark-${timestamp}.json`);

    spinner.text = `Reading tasks from ${metadataPath}`;

    // Read all tasks from the JSONL file
    const tasks: Task[] = [];
    const fileStream = fs.createReadStream(metadataPath);
    const rl = createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (line.trim()) {
        try {
          const task = JSON.parse(line);
          tasks.push(task);
        } catch (e) {
          console.error(`Failed to parse line: ${line}`);
        }
      }
    }

    // Limit the number of tasks if specified
    const tasksToRun = maxTasks ? tasks.slice(0, maxTasks) : tasks;

    spinner.succeed(`Loaded ${tasksToRun.length}/${tasks.length} tasks`);

    // Results array to store benchmark data
    const results: BenchmarkResult[] = [];
    let correct = 0;
    let total = 0;

    // Process each task
    for (let i = 0; i < tasksToRun.length; i++) {
      const task = tasksToRun[i];
      const taskSpinner = ora(
        `Processing task ${i + 1}/${tasksToRun.length} (ID: ${task.task_id})`,
      ).start();

      try {
        // Check if there's an attached file
        let hasAttachedFile = false;
        if (task.file_name && task.file_name.trim() !== '') {
          const filePath = path.join(filesDir, task.file_name);
          hasAttachedFile = fs.existsSync(filePath);
        }

        // Create question with file reference if needed
        let question = task.Question;
        if (hasAttachedFile) {
          question += ` (See attached file: ${task.file_name})`;
        }

        // Run the agent on this task
        const startTime = Date.now();
        const { output, error } = await runTask(question);
        const endTime = Date.now();

        if (error) {
          taskSpinner.fail(
            `Task ${i + 1}/${tasksToRun.length} - Error: ${error}`,
          );

          // Record the error
          results.push({
            task_id: task.task_id,
            question: task.Question,
            level: task.Level,
            official_answer: task['Final answer'],
            agent_answer: 'ERROR: ' + error,
            is_correct: false,
            has_attached_file: hasAttachedFile,
            execution_time: (endTime - startTime) / 1000,
          });

          continue;
        }

        // Extract the answer from the output
        const agentAnswer = extractAnswer(output);

        // Calculate metrics
        const executionTime = (endTime - startTime) / 1000; // in seconds
        const isCorrect = isAnswerCorrect(task['Final answer'], agentAnswer);

        if (isCorrect) correct++;
        if (task['Final answer'] !== '?') total++;

        // Store the result
        results.push({
          task_id: task.task_id,
          question: task.Question,
          level: task.Level,
          official_answer: task['Final answer'],
          agent_answer: agentAnswer,
          is_correct: isCorrect,
          has_attached_file: hasAttachedFile,
          execution_time: executionTime,
        });

        // Log progress
        if (isCorrect) {
          taskSpinner.succeed(
            `Task ${i + 1}/${tasksToRun.length} - Correct answer! (${executionTime.toFixed(2)}s)`,
          );
        } else {
          taskSpinner.fail(
            `Task ${i + 1}/${tasksToRun.length} - Incorrect answer (${executionTime.toFixed(2)}s)`,
          );
        }

        // Save results after each task in case of crashes
        fs.writeFileSync(
          resultsFile,
          JSON.stringify(
            {
              timestamp: new Date().toISOString(),
              total_tasks: tasks.length,
              completed_tasks: i + 1,
              correct_answers: correct,
              total_evaluated: total,
              accuracy: total > 0 ? correct / total : 0,
              results,
            },
            null,
            2,
          ),
        );
      } catch (error) {
        taskSpinner.fail(
          `Failed to process task ${i + 1}/${tasksToRun.length}: ${error}`,
        );

        // Still record the failure
        results.push({
          task_id: task.task_id,
          question: task.Question,
          level: task.Level,
          official_answer: task['Final answer'],
          agent_answer:
            'ERROR: ' +
            (error instanceof Error ? error.message : String(error)),
          is_correct: false,
          has_attached_file: false,
          execution_time: 0,
        });
      }

      // Small delay between tasks to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Calculate overall metrics
    const accuracy = total > 0 ? (correct / total) * 100 : 0;
    const averageTime =
      results.reduce((sum, r) => sum + r.execution_time, 0) / results.length;

    // Analyze results by difficulty level
    const levelStats = analyzeResultsByLevel(results);

    // Log final results
    console.log('\n' + chalk.bold('======= BENCHMARK RESULTS ======='));
    console.log(`Tasks processed: ${results.length}/${tasksToRun.length}`);
    console.log(`Tasks with known answers: ${total}`);
    console.log(`Correct answers: ${correct}/${total}`);
    console.log(`Accuracy: ${accuracy.toFixed(2)}%`);
    console.log(`Average execution time: ${averageTime.toFixed(2)} seconds`);

    // Log results by level
    console.log('\n' + chalk.bold('Results by difficulty level:'));
    for (const level in levelStats) {
      const stats = levelStats[level];
      console.log(
        `Level ${level}: ${stats.correct}/${stats.total} correct (${stats.accuracy.toFixed(2)}%)`,
      );
    }

    console.log(`\nResults saved to: ${resultsFile}`);
    console.log(chalk.bold('================================'));

    // Save final results with level stats
    fs.writeFileSync(
      resultsFile,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          total_tasks: tasks.length,
          completed_tasks: results.length,
          correct_answers: correct,
          total_evaluated: total,
          accuracy: total > 0 ? (correct / total) * 100 : 0,
          average_execution_time: averageTime,
          level_stats: levelStats,
          results,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    spinner.fail(
      `Benchmark failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(error);
    process.exit(1);
  }
}

// Show usage information if requested
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
GAIA Benchmark Runner

Usage:
  yarn benchmark [options]

Options:
  -l, --limit <number>  Limit the number of tasks to run
  -h, --help            Show this help information
  `);
  process.exit(0);
}

// Run the benchmark when this script is executed directly
if (require.main === module) {
  runBenchmark().catch((error) => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
}

export { runBenchmark };
